(ns io.github.getcolors.n8n.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.validate :as once-validate]))

(def profile-par (green-cli/par-name :profile))

(def required
  "Every key desired state must carry.

  Two deliberate absences carried over from `neon`: `vultr-ssh-keys` selects
  opt-out mode by being present (SSH Keypair Standard), so requiring it would
  make every conforming keygen deployment invalid, and `vultr-name` is the
  Compute Name Standard's optional override.

  Unlike `neon`, this package DOES require `provider-dns`. Neon publishes
  nothing and is reached through an SSH tunnel; n8n is a public application
  whose whole purpose is receiving webhooks from third parties, so a name and a
  certificate are not optional extras here."
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy
   ;; storage tier — neon's own vocabulary, because this package renders
   ;; neon's templates rather than copying them (see deps.edn)
   :neon-image :neon-compute-image :neon-pg-version
   :neon-tenant-id :neon-timeline-id
   :neon-database :neon-role
   :neon-r2-bucket :neon-r2-endpoint :neon-r2-region :neon-r2-prefix
   ;; application tier
   :n8n-image :n8n-runners-image :n8n-host :n8n-port
   :n8n-owner-email :n8n-proxy-hops :n8n-timezone :n8n-data-dir
   :n8n-binary-data-mode :n8n-concurrency-production-limit
   :n8n-executions-data-max-age :n8n-executions-data-prune-max-count
   :n8n-block-env-access-in-node :n8n-enforce-settings-file-permissions
   :n8n-git-node-disable-bare-repos :n8n-restrict-file-access-to
   :caddy-image
   ;; backups — the only whole-host recovery source
   :n8n-backup-r2-bucket :n8n-backup-oncalendar :n8n-backup-retention-days
   :n8n-backup-dir
   ;; public name and TLS
   :cloudflare-zone :cloudflare-record-name :cloudflare-proxied
   ;; compute
   :vultr-region :vultr-plan :vultr-os-id
   :vultr-ssh-sources :vultr-http-sources
   :r2-bucket :r2-endpoint])

(def image-keys [:neon-image :neon-compute-image :n8n-image :n8n-runners-image
                 :caddy-image])

(def soak-keys
  [:n8n-soak-concurrent-workflows :n8n-soak-duration-seconds
   :n8n-soak-mix-api-percent :n8n-soak-mix-code-node-percent
   :n8n-soak-mix-binary-percent
   :n8n-soak-code-node-payload-mb :n8n-soak-binary-payload-mb
   :n8n-soak-max-p95-sql-roundtrip-ms :n8n-soak-max-p99-sql-roundtrip-ms
   :n8n-soak-max-p95-execution-ms :n8n-soak-max-p99-execution-ms
   :n8n-soak-min-executions-completed
   :n8n-soak-max-host-memory-percent :n8n-soak-max-disk-percent])

(def image-re #"^[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64}|:[^\s:@]+@sha256:[0-9a-f]{64})$")
(def hex32-re #"^[0-9a-f]{32}$")
(def ident-re #"^[a-z_][a-z0-9_]*$")
(def url-re #"^https://[^\s]+$")
(def host-re #"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")
(def email-re #"^[^@\s]+@[^@\s]+\.[^@\s]+$")
(def version-tag-re #":([^\s:@/]+)@sha256:")

(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))

(defn placeholder? [v]
  (or (missing? v) (= "REPLACE_ME" (str/trim (str v)))))

(defn compute-name [opts]
  (let [override (:vultr-name opts)]
    (if (placeholder? override) (str (:profile opts)) (str/trim (str override)))))

(defn keygen? [opts] (once-ssh/keygen? opts))

(defn image-version
  "The human-readable tag out of a `repo:tag@sha256:...` pin, or nil."
  [v]
  (second (re-find version-tag-re (str v))))

(defn effective-r2
  "Which credential pair reaches the host for Neon remote storage.

  A split `COLORS_PAR_NEON_R2_*` pair is preferred; when it is absent the
  shared `COLORS_PAR_R2_*` pair is used instead. That fallback is what the
  deployment currently runs on, and it is the reason the backup-credential
  scoping gate reports SKIPPED rather than passing — one credential reaching
  state, live data and backups alike is a real weakness, so it is named here
  rather than hidden behind a default."
  [opts]
  (if (and (not (missing? (:neon-r2-access-key-id opts)))
           (not (missing? (:neon-r2-secret-access-key opts))))
    {:split? true
     :access-key-id (:neon-r2-access-key-id opts)
     :secret-access-key (:neon-r2-secret-access-key opts)}
    {:split? false
     :access-key-id (:r2-access-key-id opts)
     :secret-access-key (:r2-secret-access-key opts)}))

(defn backup-credential-scoped?
  "Whether a backup-only credential was supplied. Gate R2 is conditional on
  this and reports its reason when false."
  [opts]
  (and (not (missing? (:n8n-backup-r2-access-key-id opts)))
       (not (missing? (:n8n-backup-r2-secret-access-key opts)))))

(defn credential-sharing-accepted?
  "Whether desired state explicitly accepts one R2 credential reaching
  OpenTofu state, live Neon data, and backups alike."
  [opts]
  (= "shared-accepted" (str (:r2-credential-sharing opts))))

(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(defn- int-like? [v] (or (integer? v) (and (string? v) (re-matches #"^-?\d+$" v))))
(defn- as-int [v] (when (int-like? v) (if (integer? v) v (Long/parseLong v))))

(defn state-errors [opts]
  (vec
   (concat
    (for [k required :when (missing? (get opts k))] (str k " is required"))
    (for [k soak-keys :when (missing? (get opts k))] (str k " is required"))

    (when-not (= "vultr" (:provider-compute opts))
      [":provider-compute must be vultr"])
    (when-not (= "cloudflare" (:provider-dns opts))
      [":provider-dns must be cloudflare"])
    (when-not (contains? #{"local" "s3" "r2"} (:provider-backend opts))
      [":provider-backend must be local, s3, or r2"])
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])

    ;; --- images ------------------------------------------------------------
    (for [k image-keys
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches image-re (str v))))]
      (str k " must carry an explicit image tag or digest"))
    (for [k image-keys
          :let [v (str (get opts k))]
          :when (and (not (missing? (get opts k)))
                     (not (str/includes? v "@sha256:")))]
      (str k " must be pinned by digest (tag@sha256:...)"))

    ;; Upstream requires the task runner image version to equal the n8n image
    ;; version. A mismatch is a protocol mismatch between the broker and the
    ;; runner, and it fails at workflow-execution time rather than at boot —
    ;; long after a converge would have reported success.
    (let [a (image-version (:n8n-image opts))
          b (image-version (:n8n-runners-image opts))]
      (when (and a b (not= a b))
        [(str ":n8n-runners-image version " b " must equal :n8n-image version " a)]))

    ;; --- storage tier -------------------------------------------------------
    (when-not (or (missing? (:neon-pg-version opts))
                  (contains? #{14 15 16 17} (:neon-pg-version opts)))
      [":neon-pg-version must be 14, 15, 16, or 17"])
    (for [k [:neon-tenant-id :neon-timeline-id]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches hex32-re (str v))))]
      (str k " must be 32 lowercase hex characters"))
    (for [k [:neon-database :neon-role]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches ident-re (str v))))]
      (str k " must be a lowercase identifier"))
    (when (= "cloud_admin" (str (:neon-role opts)))
      [":neon-role must not be cloud_admin"])
    (for [k [:neon-r2-endpoint]
          :when (and (not (missing? (get opts k)))
                     (not (re-matches url-re (str (get opts k)))))]
      (str k " must be an https URL"))
    ;; Live Neon data and OpenTofu state must not share a bucket. neon-vultr
    ;; put data inside the state bucket as a bootstrap deviation; repeating it
    ;; here would mean one lifecycle mistake could take out both.
    (when (and (not (missing? (:neon-r2-bucket opts)))
               (= (str (:neon-r2-bucket opts)) (str (:r2-bucket opts))))
      [":neon-r2-bucket must not be the OpenTofu state bucket"])
    ;; hash-set, not the #{} literal: when the two buckets are equal -- exactly
    ;; the misconfiguration this rule exists to catch -- a set literal with
    ;; duplicate values throws IllegalArgumentException at runtime, so the
    ;; validator crashed instead of reporting the problem it had found.
    (when (and (not (missing? (:n8n-backup-r2-bucket opts)))
               (contains? (hash-set (str (:r2-bucket opts)) (str (:neon-r2-bucket opts)))
                          (str (:n8n-backup-r2-bucket opts))))
      [":n8n-backup-r2-bucket must not be the state or live-data bucket"])

    ;; --- application tier ---------------------------------------------------
    (when-not (or (missing? (:n8n-host opts))
                  (re-matches host-re (str (:n8n-host opts))))
      [":n8n-host must be a fully qualified hostname"])
    (when-not (or (missing? (:n8n-owner-email opts))
                  (re-matches email-re (str (:n8n-owner-email opts))))
      [":n8n-owner-email must be an email address"])
    (when-not (or (missing? (:n8n-port opts)) (int-like? (:n8n-port opts)))
      [":n8n-port must be a port number"])

    ;; Two proxies sit in front of n8n here (Cloudflare, then Caddy). n8n's
    ;; default is 0, which makes it trust the nearest hop and mis-attribute
    ;; every client address.
    (when-not (or (missing? (:n8n-proxy-hops opts))
                  (when-let [n (as-int (:n8n-proxy-hops opts))] (<= 0 n 10)))
      [":n8n-proxy-hops must be an integer between 0 and 10"])
    (when (and (true? (:cloudflare-proxied opts))
               (when-let [n (as-int (:n8n-proxy-hops opts))] (< n 2)))
      [":n8n-proxy-hops must be at least 2 when cloudflare-proxied is true (Cloudflare, then Caddy)"])

    ;; n8n's own default holds binary payloads in memory, and a Code node
    ;; duplicates its payload twice. `filesystem` is the only safe value on a
    ;; single host that also runs the database.
    (when-not (or (missing? (:n8n-binary-data-mode opts))
                  (contains? #{"filesystem" "default"} (str (:n8n-binary-data-mode opts))))
      [":n8n-binary-data-mode must be filesystem or default"])
    (when (= "default" (str (:n8n-binary-data-mode opts)))
      [":n8n-binary-data-mode must be filesystem here: `default` holds binary payloads in memory and this host also runs the database"])

    ;; n8n defaults this to -1, i.e. unbounded concurrent production executions.
    ;; Peak memory is roughly 3x the largest payload times this number.
    (when-not (or (missing? (:n8n-concurrency-production-limit opts))
                  (when-let [n (as-int (:n8n-concurrency-production-limit opts))] (pos? n)))
      [":n8n-concurrency-production-limit must be a positive integer (n8n's -1 default is unbounded and will OOM this host)"])

    (when-not (or (missing? (:n8n-executions-data-max-age opts))
                  (when-let [n (as-int (:n8n-executions-data-max-age opts))] (pos? n)))
      [":n8n-executions-data-max-age must be a positive number of HOURS"])
    (when-not (or (missing? (:n8n-executions-data-prune-max-count opts))
                  (when-let [n (as-int (:n8n-executions-data-prune-max-count opts))] (not (neg? n))))
      [":n8n-executions-data-prune-max-count must be zero or a positive integer"])

    ;; These three default to false upstream, contradicting the 2.0
    ;; breaking-changes page. Desired state must say so explicitly, and must
    ;; not be allowed to say `false` quietly.
    (for [k [:n8n-block-env-access-in-node
             :n8n-enforce-settings-file-permissions
             :n8n-git-node-disable-bare-repos]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (true? v)))]
      (str k " must be true"))

    ;; --- deprecated spellings ----------------------------------------------
    ;; WEBHOOK_URL is a deprecated alias of N8N_WEBHOOK_URL from n8n 2.35.0.
    ;; Every secondary source still names the old one, so refuse it by name
    ;; rather than letting it render into a deprecation warning nobody reads.
    (when-not (missing? (:webhook-url opts))
      [":webhook-url is the deprecated spelling; n8n 2.35.0+ uses :n8n-webhook-url (derived from :n8n-host here, so remove the key)"])
    (when-not (missing? (:n8n-runners-enabled opts))
      [":n8n-runners-enabled is deprecated from n8n 2.0; remove the key"])
    (for [k [:n8n-config-files :queue-worker-max-stalled-count
             :n8n-available-binary-data-modes]
          :when (not (missing? (get opts k)))]
      (str k " was removed in n8n 2.0; remove the key"))
    ;; n8n 2.0 dropped MySQL and MariaDB. There is no key that could select
    ;; them here, but a stale colors.yml carrying one should say why.
    (when (contains? #{"mysql" "mariadb" "mysqldb"} (str/lower-case (str (:db-type opts))))
      [":db-type mysql/mariadb support was removed in n8n 2.0"])

    ;; --- soak thresholds ----------------------------------------------------
    (let [pcts (keep #(as-int (get opts %))
                     [:n8n-soak-mix-api-percent :n8n-soak-mix-code-node-percent
                      :n8n-soak-mix-binary-percent])]
      (when (and (= 3 (count pcts)) (not= 100 (reduce + pcts)))
        [":n8n-soak-mix-* percentages must sum to 100"]))
    (for [k [:n8n-soak-max-host-memory-percent :n8n-soak-max-disk-percent]
          :let [n (as-int (get opts k))]
          :when (and n (not (<= 1 n 100)))]
      (str k " must be a percentage between 1 and 100"))

    ;; Restricting the origin to Cloudflare's ranges and NOT proxying the
    ;; record are mutually exclusive, and the failure is silent until the
    ;; certificate is needed: Caddy answers the ACME HTTP-01 challenge on :80,
    ;; and with the record unproxied that challenge arrives from Let's
    ;; Encrypt's own addresses, which the firewall drops. The converge then
    ;; succeeds, and the first HTTPS request fails on a certificate that was
    ;; never issued. Proxied, the challenge arrives from a Cloudflare address
    ;; and is admitted.
    (when (and (= "cloudflare" (str (:vultr-http-sources opts)))
               (not (true? (:cloudflare-proxied opts))))
      [":vultr-http-sources cloudflare requires :cloudflare-proxied true, or ACME HTTP-01 is firewalled off and no certificate is ever issued"])

    (when-not (or (missing? (:r2-credential-sharing opts))
                  (contains? #{"split" "shared-accepted"} (str (:r2-credential-sharing opts))))
      [":r2-credential-sharing must be split or shared-accepted"])

    (when-not (or (missing? (:vultr-os-id opts)) (integer? (:vultr-os-id opts)))
      [":vultr-os-id must be Vultr's numeric operating-system id"]))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))

(def provider-secrets
  "What talking to the providers needs, on any real event."
  [:vultr-api-key :cloudflare-api-token])

(def application-secrets
  "What converging the machine needs, and therefore only a create.

  The database role passwords, the n8n owner password and the task-runner auth
  token are deliberately absent: all three are generated on the server, once,
  and are never supplied by the operator. The encryption key is the opposite —
  it must outlive the host, so it is the operator's to hold and escrow."
  [:n8n-encryption-key])

(defn r2-secret-errors
  "The Neon remote-storage pair, honouring the split/shared fallback."
  [opts]
  (let [{:keys [access-key-id secret-access-key split?]} (effective-r2 opts)]
    (cond
      (and (missing? access-key-id) (missing? secret-access-key))
      [(str "required credential is not set: "
            (green-cli/par-name :neon-r2-access-key-id)
            " (or the shared " (green-cli/par-name :r2-access-key-id) " pair)")]
      (missing? access-key-id)
      [(str "required credential is not set: "
            (green-cli/par-name (if split? :neon-r2-access-key-id :r2-access-key-id)))]
      (missing? secret-access-key)
      [(str "required credential is not set: "
            (green-cli/par-name (if split? :neon-r2-secret-access-key :r2-secret-access-key)))]
      :else nil)))

(defn secret-errors
  "Credentials a real event needs. A delete tears down infrastructure and never
  converges anything, so it asks for the provider credentials only."
  [opts event]
  (let [ks (concat provider-secrets
                   (when (= :create event) application-secrets)
                   (backend-secrets opts))]
    (concat
     (for [k (distinct ks) :when (missing? (get opts k))]
       (str "required credential is not set: " (green-cli/par-name k)))
     (when (= :create event) (r2-secret-errors opts))
     ;; Blast radius, enforced rather than merely observed.
     ;;
     ;; This package already refuses to let backups share a BUCKET with state
     ;; or live data. Letting them silently share a CREDENTIAL was the same
     ;; property enforced on one axis and ignored on the other -- which is
     ;; worse than enforcing neither, because the visible rule implies the
     ;; invisible one is handled too.
     ;;
     ;; Measured on a live host: the shared pair could list, write and DELETE
     ;; in the OpenTofu state bucket and delete backup sets. A backup a
     ;; compromised host can erase is not a backup, and the host has no
     ;; legitimate reason to touch state at all.
     ;;
     ;; The shared pair stays reachable, because a first converge may predate
     ;; the scoped tokens -- but only as a DELIBERATE, committed choice that
     ;; shows up in a colors.yml diff, never as a silent default.
     (when (and (= :create event)
                (not (backup-credential-scoped? opts))
                (not (credential-sharing-accepted? opts)))
       [(str "backups would use the same R2 credential as OpenTofu state and live "
             "Neon data. Supply " (green-cli/par-name :n8n-backup-r2-access-key-id)
             " and " (green-cli/par-name :n8n-backup-r2-secret-access-key)
             " scoped to the backup bucket alone, or set "
             ":r2-credential-sharing: shared-accepted in colors.yml to record "
             "that the blast radius is accepted")])
     (when (and (= :create event)
                (not (:split? (effective-r2 opts)))
                (not (credential-sharing-accepted? opts)))
       [(str "live Neon data would use the same R2 credential as OpenTofu state. "
             "Supply " (green-cli/par-name :neon-r2-access-key-id) " and "
             (green-cli/par-name :neon-r2-secret-access-key)
             " scoped to the data bucket alone, or set "
             ":r2-credential-sharing: shared-accepted in colors.yml")])
     ;; n8n requires at least 32 characters. A shorter key is accepted by n8n
     ;; itself and then silently weakens every credential in the database.
     (when (and (= :create event)
                (not (missing? (:n8n-encryption-key opts)))
                (< (count (str (:n8n-encryption-key opts))) 32))
       [(str (green-cli/par-name :n8n-encryption-key)
             " must be at least 32 characters")]))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute {:vultr-api-key "VULTR_API_KEY"}
    :provider-dns     {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
