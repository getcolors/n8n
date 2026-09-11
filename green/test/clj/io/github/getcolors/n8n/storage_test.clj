(ns io.github.getcolors.n8n.storage-test
  "The managed S3 storage stage: what it requires, what it hands the converge,
  and what it refuses to adopt."
  (:require [clojure.test :refer [deftest is testing]]
            [cheshire.core :as json]
            [green.process :as process]
            [io.github.getcolors.n8n.storage :as storage]
            [io.github.getcolors.n8n.validate :as validate]
            [io.github.getcolors.n8n.validate-test :refer [base aws]]))

(def managed (assoc aws :n8n-storage-managed true))

(def credentials
  {:credentials (into {} (for [role [:neon :backup]]
                           [role {:access_key_id (str (name role) "-id") :secret_access_key (str (name role) "-secret")}]))})

(deftest managed-storage-requires-aws-compute-and-s3-state
  (is (empty? (validate/state-errors managed)))
  (testing "the message names the requirement, so a Vultr deployment that
            flips the flag learns what the flag means"
    (is (some #(= "managed storage requires :provider-compute aws" %)
              (validate/state-errors (assoc base :n8n-storage-managed true))))
    (is (some #(= "managed storage requires :provider-backend s3" %)
              (validate/state-errors (assoc base :n8n-storage-managed true)))))
  (doseq [change [{:n8n-storage-managed "true"}
                  {:neon-r2-region "auto"}
                  {:n8n-backup-r2-region "eu-west-1"}
                  {:neon-r2-bucket "Not_A_Bucket"}
                  {:n8n-backup-r2-bucket (:neon-r2-bucket aws)}
                  {:s3-bucket (:neon-r2-bucket aws)}]]
    (is (seq (validate/state-errors (merge managed change))) (pr-str change))))

(deftest managed-storage-exempts-the-operator-pairs-and-the-sharing-gate
  (testing "the pairs are minted and scoped by construction, so neither the
            COLORS_PAR_NEON_R2_* requirement nor the blast-radius gate applies"
    (is (= #{"required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN"
             "required credential is not set: COLORS_PAR_N8N_ENCRYPTION_KEY"}
           (set (validate/secret-errors managed :create))))
    (is (empty? (validate/secret-errors (assoc managed :cloudflare-api-token "c" :n8n-encryption-key (apply str (repeat 32 "k"))) :create))))
  (testing "unmanaged AWS desired state still asks for the pairs"
    (is (some #(re-find #"COLORS_PAR_NEON_R2_ACCESS_KEY_ID" %) (validate/secret-errors aws :create)))
    (is (some #(re-find #"same R2 credential" %)
              (validate/secret-errors (assoc aws :cloudflare-api-token "c" :n8n-encryption-key (apply str (repeat 32 "k"))
                                             :r2-access-key-id "a" :r2-secret-access-key "b") :create)))))

(deftest the-storage-step-is-a-no-op-when-unmanaged
  (with-redefs [process/run (fn [& _] (throw (AssertionError. "unmanaged storage must not provision")))]
    (is (= 0 (:green/exit (storage/step (assoc base :green/event :create)))))
    (is (= 0 (:green/exit (storage/step (assoc aws :green/event :delete)))))))

(deftest minted-pairs-reach-the-existing-lookups-and-nothing-else
  (let [env (storage/credential-env (assoc managed :n8n/storage-credentials credentials))]
    (is (= "neon-id" (get env "COLORS_PAR_NEON_R2_ACCESS_KEY_ID")))
    (is (= "neon-secret" (get env "COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY")))
    (is (= "backup-id" (get env "COLORS_PAR_N8N_BACKUP_R2_ACCESS_KEY_ID")))
    (is (= "backup-secret" (get env "COLORS_PAR_N8N_BACKUP_R2_SECRET_ACCESS_KEY")))
    (is (= "False" (get env "ANSIBLE_HOST_KEY_CHECKING")))
    (is (nil? (get env "AWS_ACCESS_KEY_ID"))))
  (testing "string keys, as green.tofu leaves nested output values"
    (let [wire (json/parse-string (json/generate-string credentials) false)
          env (storage/credential-env (assoc managed :n8n/storage-credentials {:credentials (get wire "credentials")}))]
      (is (= "backup-secret" (get env "COLORS_PAR_N8N_BACKUP_R2_SECRET_ACCESS_KEY")))))
  (testing "an absent pair is a refusal, never an empty variable"
    (is (thrown? Exception (storage/credential-env managed)))))

(deftest ownership-rejects-existing-buckets-and-unreadable-state
  (doseq [probe [{:exit 0 :out ""} {:exit 1 :err "(403) Forbidden"}]]
    (with-redefs [process/run (fn [args _] (if (= "aws" (first args)) probe {:exit 0 :out ""}))]
      (is (thrown? Exception (storage/ownership-preflight! managed)))))
  (with-redefs [process/run (fn [args _] (if (= args ["tofu" "state" "list"]) {:exit 1 :err "AccessDenied"} {:exit 0 :out ""}))]
    (is (thrown? Exception (storage/ownership-preflight! managed)))))

(deftest a-first-create-probes-both-buckets-and-passes-on-404
  (let [probes (atom [])]
    (with-redefs [process/run (fn [args _]
                                (cond
                                  (= args ["tofu" "state" "list"]) {:exit 1 :err "No state file was found!"}
                                  (= "aws" (first args)) (do (swap! probes conj (nth args 4)) {:exit 254 :err "(404) Not Found"})
                                  :else {:exit 0 :out ""}))]
      (storage/ownership-preflight! managed)
      (is (= #{(:neon-r2-bucket aws) (:n8n-backup-r2-bucket aws)} (set @probes))))))

(deftest a-tracked-address-must-name-the-configured-bucket
  (with-redefs [process/run (fn [args _]
                              (cond
                                (= args ["tofu" "state" "list"]) {:exit 0 :out "aws_s3_bucket.application[\"neon\"]"}
                                (= args ["tofu" "show" "-json"]) {:exit 0 :out (json/generate-string {:values {:root_module {:resources [{:address "aws_s3_bucket.application[\"neon\"]" :values {:bucket "someone-elses-bucket"}}]}}})}
                                :else {:exit 0 :out ""}))]
    (is (thrown? Exception (storage/ownership-preflight! managed)))))
