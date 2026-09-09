(ns io.github.getcolors.n8n.workflow
  (:require [clojure.walk :as walk]
            [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.n8n.compute :as compute]
            [io.github.getcolors.n8n.ssh-config :as ssh-config]
            [io.github.getcolors.n8n.tools :as tools]
            [io.github.getcolors.n8n.validate :as validate]))

(def defaults {:provider-compute "vultr" :provider-dns "cloudflare"
               :provider-backend "r2" :compute-prevent-destroy true
               :workdir ".colors"})

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight
    opts {:defaults defaults :overlay green-cli/read-pars
          :validators
          [(fn [_ env _] (validate/env-errors env))
           (fn [opts _ _] (validate/state-errors opts))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (contains? #{:create :delete} event))
               (validate/secret-errors opts event)))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (= :delete event) (:compute-prevent-destroy opts))
               [(str "compute destruction is protected; set "
                     (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]
          :after-validate
          (fn [opts _ {:keys [event real?]}]
            (if (and real? (= :create event)) (ssh-config/preflight! (assoc opts :green/exit 0)) (assoc opts :green/exit 0)))} env)))

(defn wire-fn [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :n8n/start [start-step :n8n/load]
      :n8n/load [compute/load-step :n8n/ansible]
      :n8n/ansible [tools/ansible-step :n8n/ssh-config]
      ;; The `~/.ssh/config` block goes before the destroy, the opposite of the
      ;; keypair below. A block that outlives its host is stale but harmless; a
      ;; key that predeceases its host locks the operator out of a machine that
      ;; still exists. Both orders are deliberate; see standards/ssh-config.md.
      :n8n/ssh-config [tools/ansible-local-step :n8n/dns]
      ;; DNS goes before the compute destroy: a record pointing at an address
      ;; that no longer answers is a live outage for anything still resolving
      ;; it, while a record removed slightly early merely 404s.
      :n8n/dns [tools/dns-step :n8n/infrastructure]
      :n8n/infrastructure [tools/infrastructure-step])
    (case step
      :n8n/start [start-step :n8n/infrastructure]
      ;; After compute, which is where the address first exists, and before the
      ;; stage that converges the machine — the converge and the acceptance
      ;; both ride the alias this stage writes.
      :n8n/infrastructure [tools/infrastructure-step :n8n/dns]
      ;; DNS before the converge, not after: Caddy provisions its certificate
      ;; over ACME on first start, and the HTTP-01 challenge needs the name to
      ;; already resolve to this host. Converging first would make the first
      ;; boot fail its certificate and retry on ACME's backoff.
      :n8n/dns [tools/dns-step :n8n/ssh-config]
      :n8n/ssh-config [tools/ansible-local-step :n8n/ansible]
      :n8n/ansible [tools/ansible-step :n8n/acceptance]
      :n8n/acceptance [tools/acceptance-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(def side-effecting
  [:n8n/infrastructure :n8n/dns :n8n/ssh-config
   :n8n/ansible :n8n/acceptance :n8n/load])

(def workflow
  (-> (wf/workflow {:start :n8n/start :wire-fn wire-fn})
      (wf/advice-add :n8n/dns :before ::backend (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting)))
