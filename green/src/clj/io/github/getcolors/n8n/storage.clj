(ns io.github.getcolors.n8n.storage
  "Opt-in deployment-owned S3 buckets for Neon data and backups, each with its
  own bucket-scoped IAM identity.

  Modelled on the langfuse package's storage stage. The stage exists only when
  `n8n-storage-managed` is true; otherwise every function here is a no-op and
  the operator supplies the two credential pairs by hand, as before."
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.cli :as cli]
            [green.process :as process]
            [green.scaffold :as scaffold]
            [green.tofu :as tofu]))

(def tool "n8n-storage")
(defn managed? [opts] (true? (:n8n-storage-managed opts)))
(defn directory [opts] (cli/stage-dir opts tool {:default-profile "n8n"}))

(defn aws-env
  "AWS credentials supplied as COLORS_PAR_AWS_* overlays, mapped onto the
  variable names the AWS SDK reads. Empty when the operator relies on the
  ambient credential chain instead."
  [opts]
  (into {} (keep (fn [[key variable]] (when-let [value (not-empty (str (get opts key)))] [variable value])))
        {:aws-access-key-id "AWS_ACCESS_KEY_ID" :aws-secret-access-key "AWS_SECRET_ACCESS_KEY"
         :aws-session-token "AWS_SESSION_TOKEN"}))

(def roles
  "Bucket roles, in the order the template declares them, each paired with
  the desired-state key naming its bucket and the COLORS_PAR_ prefix its
  credential reaches Ansible under."
  [{:role "neon" :bucket-key :neon-r2-bucket :prefix "NEON_R2"}
   {:role "backup" :bucket-key :n8n-backup-r2-bucket :prefix "N8N_BACKUP_R2"}])

(defn specs [opts]
  [{:template :io.github.getcolors.n8n.tools.storage/main.tf
    :target (str (directory opts) "/main.tf") :data opts :opts scaffold/preserve-jinja-delimiters}])

(defn- checked [args options]
  (let [result (process/run args options)]
    (when-not (zero? (:exit result))
      (throw (ex-info "managed storage state operation failed" {})))
    (:out result)))

(defn ownership-preflight!
  "Refuse existing buckets unless this stage already owns their Terraform
  address. A bucket that answers anything but 404 to a head-bucket probe is
  someone's, or unreachable; both fail closed."
  [opts]
  (let [options {:dir (directory opts) :extra-env (aws-env opts)}]
    (checked ["tofu" "init" "-input=false" "-no-color"] options)
    (let [state (process/run ["tofu" "state" "list"] options)
          empty-state? (and (= 1 (:exit state)) (str/includes? (str (:err state)) "No state file was found!"))
          _ (when-not (or (zero? (:exit state)) empty-state?)
              (throw (ex-info "managed storage state unavailable" {})))
          addresses (set (str/split-lines (if empty-state? "" (:out state))))
          recorded (if (empty? addresses) {}
                       (into {} (map (juxt :address #(get-in % [:values :bucket])))
                             (get-in (json/parse-string (checked ["tofu" "show" "-json"] options) true) [:values :root_module :resources])))]
      (doseq [{:keys [role bucket-key]} roles
              :let [bucket (get opts bucket-key)]]
        (when-not (= bucket (get recorded (str "aws_s3_bucket.application[\"" role "\"]")))
          (let [result (process/run ["aws" "s3api" "head-bucket" "--bucket" bucket "--region" (:neon-r2-region opts)] options)]
            ;; 403, network failures, and a successful probe all fail closed.
            (when-not (and (pos? (:exit result)) (re-find #"\(404\)|Not Found|NoSuchBucket" (str (:err result))))
              (throw (ex-info "managed storage refuses to adopt an existing or inaccessible bucket" {})))))))))

(defn step [opts]
  (if-not (managed? opts) (assoc opts :green/exit 0)
    (try
      (let [documents (specs opts)
            event (:green/event opts)]
        (when (= :create event)
          (scaffold/scaffold opts documents)
          (ownership-preflight! opts))
        ;; Scoped credentials stay in memory and in the encrypted backend state.
        ;; They are never copied into template values or printed.
        (tofu/tofu-with-spec opts documents
          {:dir (directory opts) :env (aws-env opts) :output-key :n8n/storage-credentials}))
      (catch Exception _ (assoc opts :green/exit 1 :green/err "managed S3 storage failed; inspect bucket ownership, state access, and AWS permissions")))))

(defn credential-env
  "The minted pairs as the COLORS_PAR_ variables the plays already look up,
  for the Ansible subprocess environment only. Throws when a pair is absent,
  so a converge never runs with an empty credential."
  [opts]
  ;; green.tofu keywords output names only; JSON object values retain string keys.
  (reduce (fn [env {:keys [role prefix]}]
            (let [{:keys [access_key_id secret_access_key]} (get (walk/keywordize-keys (get-in opts [:n8n/storage-credentials :credentials])) (keyword role))]
              (when (or (str/blank? access_key_id) (str/blank? secret_access_key))
                (throw (ex-info "managed storage credentials unavailable" {})))
              (assoc env (str "COLORS_PAR_" prefix "_ACCESS_KEY_ID") access_key_id
                         (str "COLORS_PAR_" prefix "_SECRET_ACCESS_KEY") secret_access_key)))
          {"ANSIBLE_HOST_KEY_CHECKING" "False"}
          roles))
