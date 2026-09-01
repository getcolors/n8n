(ns io.github.getcolors.n8n.tools
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.n8n.ssh-config :as ssh-config]
            [io.github.getcolors.n8n.validate :as validate]))

(def infrastructure-tool "n8n-infrastructure")
(def dns-tool "n8n-dns")
(def ansible-tool "n8n-ansible")
(def ansible-local-tool "n8n-ansible-local")
(def root "io.github.getcolors.n8n.tools")

;; The storage tier's templates live in the SHA-pinned getcolors/neon
;; dependency, not in this repository. deps.edn there publishes src/resources,
;; so they resolve as namespaced keyword resources off the classpath and are
;; rendered from the dependency — never copied in here, never edited. A copy of
;; a tier this subtle drifts, and the drift is silent.
(def neon-root "io.github.getcolors.neon.tools")
(def template-opts sc/preserve-jinja-delimiters)

(defn tool-dir [opts tool] (green-cli/stage-dir opts tool {:default-profile "n8n"}))
(defn template [path file] (keyword (str root "." path) file))
(defn neon-template [path file] (keyword (str neon-root "." path) file))
(defn spec [source target data] {:template source :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))

(defn cidrs [opts k]
  (let [v (get opts k) xs (if (sequential? v) v (str/split (str v) #"[,\s]+"))]
    (->> xs (map (comp str/trim str)) (remove str/blank?) vec)))

(defn credential-env [opts & slots]
  (not-empty
   (into {} (keep (fn [[k env-var]]
                    (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (apply merge (map #(validate/tofu-env opts %) (conj (vec slots) :provider-backend))))))
(defn backend-credential-env [opts] (credential-env opts))

(defn fallback-params [opts]
  {:ip "192.0.2.10" :user "root" :sudoer "root" :name (validate/compute-name opts)})
(defn output-params [result]
  (some-> (get-in result [:tofu/outputs :params]) walk/keywordize-keys))

;; The Neon data prefix inside the R2 bucket. Everything the pageserver and
;; safekeeper write — and the ownership markers guarding adoption — lives
;; under `<profile>/data/`. The tofu state for the same deployment lives at
;; `<profile>/<stage>.tfstate` in the same bucket, a sibling key space that
;; never collides with this one.
(defn r2-prefix [opts] (str (:profile opts) "/data"))

;; ---------------------------------------------------------------- compute

;; Cloudflare's published ranges, current as of 2026-09-01. Used when
;; `vultr-http-sources` is the symbolic value `cloudflare` and the live fetch is
;; unavailable — a `build` on a fresh checkout with no network must still
;; render, or the offline-render guarantee this workspace relies on is gone.
;; A real converge prefers the fetch and FAILS rather than silently widening.
(def cloudflare-ranges-fallback
  ["173.245.48.0/20" "103.21.244.0/22" "103.22.200.0/22" "103.31.4.0/22"
   "141.101.64.0/18" "108.162.192.0/18" "190.93.240.0/20" "188.114.96.0/20"
   "197.234.240.0/22" "198.41.128.0/17" "162.158.0.0/15" "104.16.0.0/13"
   "104.24.0.0/14" "172.64.0.0/13" "131.0.72.0/22"
   "2400:cb00::/32" "2606:4700::/32" "2803:f800::/32" "2405:b500::/32"
   "2405:8100::/32" "2a06:98c0::/29" "2c0f:f248::/32"])

(defn fetch-cloudflare-ranges
  "Cloudflare's published ranges, or nil when they cannot be fetched.

  Never widens on failure: the caller decides, and on a real event it stops."
  []
  (try
    (let [pull (fn [u] (-> (slurp u) str/split-lines (->> (map str/trim) (remove str/blank?))))
          xs (concat (pull "https://www.cloudflare.com/ips-v4")
                     (pull "https://www.cloudflare.com/ips-v6"))]
      (when (seq xs) (vec xs)))
    (catch Exception _ nil)))

(defn http-sources
  "The origin ingress list.

  `cloudflare` is a symbolic source this package RESOLVES — not a pinned list in
  desired state, which an earlier draft wrongly called it. Returns the resolved
  set plus how it was obtained, so the caller can record a checksum and so a
  real converge can refuse to proceed on a stale fallback."
  [opts]
  (let [v (:vultr-http-sources opts)]
    (if-not (= "cloudflare" (str v))
      {:source :explicit :ranges (cidrs opts :vultr-http-sources)}
      (if-let [live (fetch-cloudflare-ranges)]
        {:source :fetched :ranges live}
        {:source :fallback :ranges cloudflare-ranges-fallback}))))

(defn ranges-checksum [xs]
  (let [d (java.security.MessageDigest/getInstance "SHA-256")]
    (->> (str/join "\n" (sort xs)) .getBytes (.digest d)
         (map #(format "%02x" %)) str/join (take 16) str/join)))

(defn infrastructure-data [opts]
  (let [{:keys [source ranges]} (http-sources opts)]
    (assoc opts
           :compute-name (validate/compute-name opts)
           :ssh-keygen (validate/keygen? opts)
           :ssh-sources-hcl (tofu/hcl-list (cidrs opts :vultr-ssh-sources))
           :http-sources-hcl (tofu/hcl-list ranges)
           :http-sources-origin (name source)
           :http-sources-ranges (vec ranges)
           :http-sources-checksum (ranges-checksum ranges))))

(defn infrastructure-step [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        data (infrastructure-data opts)
        specs [(spec (template "infrastructure" "main.tf") (str dir "/main.tf") data)
               ;; The resolved range set is recorded, with a checksum, so a
               ;; firewall change is explainable after the fact rather than an
               ;; unattributable diff in a provider plan.
               (raw-spec (str dir "/http-sources.json")
                         (json/generate-string
                          {:origin (:http-sources-origin data)
                           :checksum (:http-sources-checksum data)
                           :ranges (:http-sources-ranges data)}
                          {:pretty true}))]
        result (tofu/tofu-with-spec opts specs
                                    {:dir dir :env (credential-env opts :provider-compute)})]
    (cond
      (wf/failed? result) result
      (= :build (:green/event opts)) (merge result (fallback-params opts))
      (= :delete (:green/event opts)) result
      :else (merge result (fallback-params opts) (output-params result)))))

;; ---------------------------------------------------------- ansible (local)

(defn ansible-local-data
  "Only what a `build` genuinely knows. The address, the user and the alias are
  run-time facts and reach the play as extra-vars instead, so the rendered
  playbook carries no IP and is identical on every workstation (SSH Config
  Standard §6)."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :ssh-config-identity-file (ssh-config/identity-file opts)))

(defn ansible-local-specs [opts]
  (let [dir (tool-dir opts ansible-local-tool) data (ansible-local-data opts)]
    ;; Also the dependency's, unchanged: the ~/.ssh/config block this writes is
    ;; the SSH Config Standard's, and it is parameterised by profile and address
    ;; alone. A second implementation here would be a second thing to keep
    ;; conformant with a standard that already has a reference implementation.
    [(spec (neon-template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (neon-template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (neon-template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ansible-local-step
  "Write or remove the `~/.ssh/config` block. The same playbook serves both
  events; `block_state` is what distinguishes them."
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        delete? (= :delete (:green/event opts))]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.ini"
       :playbooks {:create "main.yml" :delete "main.yml"}
       :extra-vars {:host_alias (ssh-config/host-alias opts)
                    :ip (or (:ip opts) (:ip (fallback-params opts)))
                    :user (or (:user opts) "root")
                    :block_state (if delete? "absent" "present")}}
      (ansible-local-specs opts))))

;; ---------------------------------------------------------------- ansible

(defn inventory
  "One host in two groups.

  The imported getcolors/neon play targets `hosts: neon` and this package's
  play targets `hosts: n8n`; both converge the same machine. Ansible supports a
  host in several groups, but group_vars precedence between them would be a
  live hazard, so every value is a HOST var here and neither group carries
  variables at all. Nothing can then depend on which group won."
  [opts]
  (json/generate-string
   {:all {:children
          {:neon {:hosts {(:profile opts) nil}}
           :n8n  {:hosts {(:profile opts) nil}}}
          :hosts {(:profile opts)
                  {:ansible_host (or (:ip opts) "192.0.2.10")
                   :ansible_user "root"}}}}
   {:pretty true}))

(defn ansible-data
  "Template values for the Ansible stage.

  Deliberately carries neither operator secret. The R2 pair reaches the host
  as Ansible `lookup('env', ...)` expressions written literally into main.yml,
  where `preserve-jinja-delimiters` passes them through untouched — routing
  them through this map instead would let Selmer HTML-escape the quotes and
  hand Ansible `&#39;`. The secret therefore exists only in the process that
  needs it: not in `.colors/`, not in a golden, not in this map."
  [opts]
  (assoc opts
         :ip (or (:ip opts) "192.0.2.10")
         :ssh-keygen (validate/keygen? opts)
         :neon-r2-prefix (or (:neon-r2-prefix opts) (r2-prefix opts))))

(defn neon-specs
  "The storage tier, rendered UNCHANGED from the pinned dependency into its own
  `neon/` subdirectory.

  The subdirectory is not tidiness. The upstream play copies its files by
  relative `src:` name (`main.yml:106`), so rendering them flat beside this
  package's templates would let an n8n file with the same basename win
  silently. Keeping the bundle whole and separate is what makes `import_playbook
  neon/main.yml` mean the dependency's play and nothing else."
  [dir data]
  (let [sub (str dir "/neon")]
    (mapv (fn [f] (spec (neon-template "ansible" f) (str sub "/" f) data))
          ["ansible.cfg" "main.yml" "cleanup.yml" "compose.yml"
           "pageserver.toml" "identity.toml" "config.json" "scramgen.py"
           "bootstrap.sh" "smoke.sh" "status.sh" "rotate.sh"])))

(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool) data (ansible-data opts)]
    (into
     (neon-specs dir data)
     ;; The dependency's, not a local copy. Writing our own dropped its
     ;; `<% if ssh-keygen %> private_key_file` conditional, and the deployment
     ;; then had no identity to offer -- `Permission denied (publickey)` after a
     ;; ten-minute wait_for_connection timeout. Reusing it is both less code and
     ;; the only version that stays correct when the standard moves.
     [(spec (neon-template "ansible" "ansible.cfg") (str dir "/ansible.cfg") data)
      (spec (template "ansible" "site.yml") (str dir "/site.yml") data)
      (spec (template "ansible" "n8n.yml") (str dir "/n8n.yml") data)
      (spec (template "ansible" "cleanup.yml") (str dir "/cleanup.yml") data)
      ;; Installed on the host as /opt/neon/compose.override.yml, beside the
      ;; dependency's compose.yml — never passed with -f. See the header of
      ;; that template for why that is load-bearing rather than stylistic.
      (spec (template "ansible" "compose.override.yml") (str dir "/compose.override.yml") data)
      (spec (template "ansible" "Caddyfile") (str dir "/Caddyfile") data)
      (spec (template "ansible" "n8n-env.sh") (str dir "/n8n-env.sh") data)
      (spec (template "ansible" "n8n-backup.sh") (str dir "/n8n-backup.sh") data)
      (spec (template "ansible" "n8n-restore.sh") (str dir "/n8n-restore.sh") data)
      (spec (template "ansible" "n8n-monitor.sh") (str dir "/n8n-monitor.sh") data)
      (spec (template "ansible" "n8n-smoke.sh") (str dir "/n8n-smoke.sh") data)
      (spec (template "ansible" "n8n-claim-owner.sh") (str dir "/n8n-claim-owner.sh") data)
      (spec (template "ansible" "n8n-soak.sh") (str dir "/n8n-soak.sh") data)
      ;; Plain JavaScript with no template markers, but rendered through the
      ;; same path so one mechanism installs everything.
      (spec (template "ansible" "soak.js") (str dir "/soak.js") data)
      (spec (template "ansible" "acceptance.js") (str dir "/acceptance.js") data)
      (spec (template "ansible" "rehearsal.js") (str dir "/rehearsal.js") data)
      (spec (template "ansible" "n8n-rehearsal.sh") (str dir "/n8n-rehearsal.sh") data)
      (spec (template "ansible" "n8n-prune-drill.sh") (str dir "/n8n-prune-drill.sh") data)
      (spec (template "ansible" "n8n-restart-drill.sh") (str dir "/n8n-restart-drill.sh") data)
      (raw-spec (str dir "/inventory.json") (inventory data))])))

;; ------------------------------------------------------------------- dns

(defn dns-data [opts]
  (assoc opts :ip (or (:ip opts) "192.0.2.10")))

;; The data source in dns/main.tf is named `zone`, and the attribute is `id`.
;; `data.cloudflare_zone.this.zone_id` -- the shape that reads most naturally --
;; is wrong on both counts and fails only at apply time, after the compute
;; stage has already created a billable instance.
(defn zone-id [] "${data.cloudflare_zone.zone.id}")

(defn dns-json [data]
  (tofu/constructs-json
   [(tofu/construct :resource :cloudflare_dns_record :n8n
                    {:zone_id (zone-id)
                     ;; The full name, not the leaf label.
                     :name (:n8n-host data)
                     :type "A"
                     :content (:ip data)
                     ;; 1 means "automatic". Cloudflare rejects any explicit TTL
                     ;; on a proxied record, because the edge controls it.
                     :ttl 1
                     :proxied (boolean (:cloudflare-proxied data))})]))

(defn dns-step [opts]
  (let [dir (tool-dir opts dns-tool)
        data (dns-data opts)
        specs [(spec (template "dns" "main.tf") (str dir "/main.tf") data)
               (raw-spec (str dir "/record.tf.json") (dns-json data))]]
    (tofu/tofu-with-spec opts specs {:dir dir :env (credential-env opts :provider-dns)})))

(defn ansible-step [opts]
  (let [dir (tool-dir opts ansible-tool)]
    (if (and (= :delete (:green/event opts)) (not (:ip opts)))
      ;; No compute in state: there is no host to stop, and the cleanup play
      ;; would only fail against the placeholder address.
      (assoc opts :green/exit 0)
      (ansible/ansible-with-spec opts
        {:dir dir :inventory "inventory.json"
         :playbooks {:create "site.yml" :delete "cleanup.yml"}
         :host-key-checking false}
        (ansible-specs opts)))))

;; ------------------------------------------------------------- acceptance

(defn run-quiet
  "Run `args` with `env` overlaid, returning the result map. Nothing from the
  child is echoed; callers decide what becomes an error message, so a secret
  passed through `env` can never leak into output by default."
  [args env timeout-ms]
  (process/run-with-timeout args (if (seq env) {:extra-env env} {}) timeout-ms))

(defn psql-args
  "A psql invocation with an explicit everything: host, port, role, database,
  and `-w` so a missing password fails instead of prompting. `env -i` clears
  the environment and re-admits only PATH, the password handed over through
  the runner, and a dead PGPASSFILE — so no ambient PG* variable, service
  file, or ~/.pgpass can alter what the probe proves."
  [opts port sql]
  ["bash" "-c"
   (str "exec env -i PATH=\"$PATH\" PGPASSFILE=/dev/null"
        " PGPASSWORD=\"$PGPASSWORD\" psql"
        " 'postgresql://" (:neon-role opts) "@127.0.0.1:" port
        "/" (:neon-database opts) "?connect_timeout=10'"
        " -w -v ON_ERROR_STOP=1 -tAc " (process/posix-quote sql))])

(defn tunnel-args
  "An ssh tunnel through the generated `~/.ssh/config` alias — the supported
  client path, exercised end to end: the alias, the identity file, and the
  forward. `-f` returns once the forward is up; the remote `sleep` bounds its
  lifetime so nothing needs killing on the way out. The bash wrapper exists
  for the streams: the daemonized child inherits stdout/stderr, and a runner
  that waits for the pipes to close would otherwise block until the sleep
  expires — returning exactly when the tunnel dies."
  [opts port]
  ["bash" "-c"
   (str "ssh -f -o ExitOnForwardFailure=yes -o BatchMode=yes"
        " -L " port ":127.0.0.1:55433 "
        (ssh-config/host-alias opts) " sleep 45 >/dev/null 2>&1")])

(def smoke-sql
  "One deployment-scoped row, updated deterministically: the same statement on
  every converge, so a second create reconciles instead of accumulating."
  (str "INSERT INTO colors_smoke (id, note, at) VALUES (1, 'operator-path', now())"
       " ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note, at = EXCLUDED.at;"
       " SELECT count(*) FROM colors_smoke;"))

(defn read-remote-password
  "The generated application-role password, read over SSH and held only in this
  process. Never merged into opts, never printed."
  [opts]
  (let [r (run-quiet ["ssh" "-o" "BatchMode=yes" (ssh-config/host-alias opts)
                      "cat" "/etc/neon/secrets/neon_role_password"]
                     {} 20000)]
    (when (zero? (:exit r)) (str/trim (str (:out r))))))

(defn acceptance-step
  "The operator-path gate, after a real create.

  The server-side gates already ran inside the playbook (health, the SQL
  round-trip, the auth negatives, the R2 object listings). What is checked
  from here is the one thing only this side can check: that an operator on
  this workstation reaches the database through the generated SSH config and
  a tunnel — the supported client path — with the generated password, and
  not without it."
  [opts]
  (if (not= :create (:green/event opts))
    (assoc opts :green/exit 0)
    (let [pw (read-remote-password opts)]
      (if-not (seq pw)
        (assoc opts :green/exit 1
               :green/err "acceptance: could not read the generated role password over ssh")
        (loop [ports (take 3 (repeatedly #(+ 20000 (rand-int 40000))))]
          (if-let [port (first ports)]
            (let [tunnel (run-quiet (tunnel-args opts port) {} 30000)]
              (if-not (zero? (:exit tunnel))
                (recur (rest ports))
                (let [ok (run-quiet (psql-args opts port smoke-sql)
                                    {"PGPASSWORD" pw} 30000)
                      denied (run-quiet (psql-args opts port "SELECT 1;")
                                        {"PGPASSWORD" "not-the-password"} 30000)]
                  (cond
                    (not (zero? (:exit ok)))
                    (assoc opts :green/exit 1
                           :green/err (str "acceptance: the tunnelled smoke round-trip failed: "
                                           (str/trim (str (:err ok)))))

                    ;; psql prints the INSERT command tag before the count;
                    ;; the count is the last line.
                    (not= "1" (last (str/split-lines (str/trim (str (:out ok))))))
                    (assoc opts :green/exit 1
                           :green/err (str "acceptance: colors_smoke should hold exactly one row, got "
                                           (str/trim (str (:out ok)))))

                    (zero? (:exit denied))
                    (assoc opts :green/exit 1
                           :green/err "acceptance: a wrong password was accepted through the tunnel")

                    :else
                    (assoc opts :green/exit 0
                           :neon/acceptance {:tunnel "ok" :smoke-rows "1"
                                             :wrong-password "refused"})))))
            (assoc opts :green/exit 1
                   :green/err "acceptance: no local port could carry the ssh tunnel after three attempts")))))))
