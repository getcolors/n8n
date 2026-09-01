(ns io.github.getcolors.n8n.validate-test
  "Most of these are regression tests for things the live build got wrong.

  The lesson that produced them: a trap written down in prose gets read once,
  while a validator runs on every converge. Each `deftest` below names the
  failure it prevents."
  (:require [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.n8n.validate :as v]))

(def base
  "A minimal valid desired state. Kept complete on purpose: `state-errors`
  reports every problem at once, so a fixture missing keys makes every test
  read as a pass-by-accident."
  {:profile "n8n-test" :workdir ".colors"
   :provider-compute "vultr" :provider-dns "cloudflare" :provider-backend "r2"
   :compute-prevent-destroy true
   :neon-image "ghcr.io/neondatabase/neon:release-9129@sha256:166022a72bf9983eba96d061d794f4740edbd4c3301e66202c1180acce9a323c"
   :neon-compute-image "ghcr.io/neondatabase/compute-node-v17:release-compute-9073@sha256:ed6a613231d7026b4df8b00563444b9f33745370a3b3f0a2183e723f460ba974"
   :neon-pg-version 17
   :neon-tenant-id "7b3c1e94a05d42f8b6c9e2417d580a3f"
   :neon-timeline-id "4f8a2d61c93b47e0a5d8f1620b7c94e3"
   :neon-database "n8n" :neon-role "n8n"
   :neon-r2-bucket "n8n-storage" :neon-r2-region "auto"
   :neon-r2-endpoint "https://example.r2.cloudflarestorage.com"
   :neon-r2-prefix "n8n-test/data"
   :n8n-image "docker.io/n8nio/n8n:2.36.9@sha256:a9e2e3c8006ed453238266669ea1274be7136f515abe290a2f75a0ab9044c93d"
   :n8n-runners-image "docker.io/n8nio/runners:2.36.9@sha256:99811ba57933dd77895f5fedbb555ce105bac8a82812205f6396d52a30b32e66"
   :n8n-host "n8n.example.com" :n8n-port 5678
   :n8n-owner-email "operator@example.com" :n8n-proxy-hops 2
   :n8n-timezone "Europe/Amsterdam" :n8n-data-dir "/var/lib/n8n/data"
   :n8n-binary-data-mode "filesystem" :n8n-concurrency-production-limit 10
   :n8n-executions-data-max-age 336 :n8n-executions-data-prune-max-count 10000
   :n8n-block-env-access-in-node true
   :n8n-enforce-settings-file-permissions true
   :n8n-git-node-disable-bare-repos true
   :n8n-restrict-file-access-to "/home/node/.n8n-files"
   :caddy-image "docker.io/library/caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d"
   :n8n-backup-r2-bucket "n8n-backup" :n8n-backup-oncalendar "*-*-* 00/6:00:00"
   :n8n-backup-retention-days 7 :n8n-backup-dir "/var/backups/n8n"
   :cloudflare-zone "example.com" :cloudflare-record-name "n8n"
   :cloudflare-proxied true
   :vultr-region "ams" :vultr-plan "vhp-8c-16gb-amd" :vultr-os-id 2284
   :vultr-ssh-sources ["0.0.0.0/0"] :vultr-http-sources "cloudflare"
   :r2-bucket "tofu-state-example" :r2-endpoint "https://example.r2.cloudflarestorage.com"
   :n8n-soak-concurrent-workflows 10 :n8n-soak-duration-seconds 300
   :n8n-soak-mix-api-percent 60 :n8n-soak-mix-code-node-percent 25
   :n8n-soak-mix-binary-percent 15
   :n8n-soak-code-node-payload-mb 8 :n8n-soak-binary-payload-mb 4
   :n8n-soak-max-p95-sql-roundtrip-ms 150 :n8n-soak-max-p99-sql-roundtrip-ms 500
   :n8n-soak-max-p95-execution-ms 2000 :n8n-soak-max-p99-execution-ms 8000
   :n8n-soak-min-executions-completed 500
   :n8n-soak-max-host-memory-percent 85 :n8n-soak-max-disk-percent 80})

(defn errs [m] (v/state-errors (merge base m)))
(defn has? [m needle] (boolean (some #(re-find (re-pattern needle) %) (errs m))))

(deftest a-complete-desired-state-validates
  (is (empty? (errs {}))))

(deftest reports-every-problem-at-once
  (testing "exit code 2 lists all problems; a validator that stops at the first
            makes a fresh colors.yml a guessing game"
    (is (<= 3 (count (errs {:neon-pg-version 12 :n8n-port nil :vultr-os-id "x"}))))))

;; --- version-specific regressions -----------------------------------------

(deftest rejects-the-deprecated-webhook-url-spelling
  (testing "WEBHOOK_URL is a deprecated alias from n8n 2.35.0. Every secondary
            source still names it, and so did the adversarial review."
    (is (has? {:webhook-url "https://n8n.example.com/"} ":webhook-url"))))

(deftest rejects-keys-removed-in-n8n-2
  (doseq [k [:n8n-config-files :queue-worker-max-stalled-count
             :n8n-available-binary-data-modes]]
    (is (has? {k "x"} (name k)))))

(deftest rejects-the-deprecated-runners-enabled-flag
  (is (has? {:n8n-runners-enabled true} ":n8n-runners-enabled")))

(deftest runner-image-version-must-equal-the-n8n-image-version
  (testing "upstream requires it, and a mismatch fails when a Code node first
            executes -- long after a converge reports success"
    (is (has? {:n8n-runners-image "docker.io/n8nio/runners:2.35.0@sha256:99811ba57933dd77895f5fedbb555ce105bac8a82812205f6396d52a30b32e66"}
              "must equal"))
    (is (empty? (errs {})))))

(deftest binary-data-must-not-be-held-in-memory
  (testing "n8n's own default is `default`, which keeps payloads in RAM on a
            host that also runs a pageserver and a Postgres compute"
    (is (has? {:n8n-binary-data-mode "default"} "holds binary payloads in memory"))))

(deftest concurrency-must-be-bounded
  (testing "n8n defaults to -1, unbounded"
    (is (has? {:n8n-concurrency-production-limit -1} "positive integer"))
    (is (has? {:n8n-concurrency-production-limit 0} "positive integer"))))

(deftest security-settings-must-be-explicitly-true
  (testing "all three default to FALSE in n8n's reference, contradicting the
            2.0 breaking-changes page"
    (doseq [k [:n8n-block-env-access-in-node
               :n8n-enforce-settings-file-permissions
               :n8n-git-node-disable-bare-repos]]
      (is (has? {k false} (name k))))))

;; --- the coupling that only fails later ------------------------------------

(deftest cloudflare-only-ingress-requires-a-proxied-record
  (testing "unproxied, the ACME HTTP-01 challenge arrives from Let's Encrypt's
            own addresses and is dropped by the firewall -- the converge still
            succeeds and the first HTTPS request finds no certificate"
    (is (has? {:cloudflare-proxied false} "ACME HTTP-01"))
    (is (empty? (errs {:cloudflare-proxied true})))
    (testing "an explicit range list is unaffected by the rule"
      (is (empty? (errs {:vultr-http-sources ["1.2.3.0/24"] :cloudflare-proxied false}))))))

(deftest proxy-hops-must-account-for-both-proxies
  (testing "Cloudflare, then Caddy. n8n's default of 0 trusts the nearest hop"
    (is (has? {:n8n-proxy-hops 1} "at least 2"))
    (is (empty? (errs {:n8n-proxy-hops 3})))))

;; --- blast radius -----------------------------------------------------------

(deftest live-data-must-not-share-a-bucket-with-tofu-state
  (is (has? {:neon-r2-bucket "tofu-state-example"} "must not be the OpenTofu state bucket")))

(deftest backups-must-not-share-a-bucket-with-state-or-live-data
  (is (has? {:n8n-backup-r2-bucket "tofu-state-example"} "must not be the state or live-data bucket"))
  (is (has? {:n8n-backup-r2-bucket "n8n-storage"} "must not be the state or live-data bucket")))

;; --- storage tier identity --------------------------------------------------

(deftest tenant-and-timeline-are-fixed-desired-state
  (doseq [k [:neon-tenant-id :neon-timeline-id]]
    (is (has? {k "not-hex"} "32 lowercase hex"))))

(deftest the-application-role-must-not-be-cloud-admin
  (is (has? {:neon-role "cloud_admin"} "must not be cloud_admin")))

(deftest images-must-be-digest-pinned
  (is (has? {:n8n-image "docker.io/n8nio/n8n:2.36.9"} "pinned by digest")))

;; --- soak thresholds --------------------------------------------------------

(deftest soak-mix-must-sum-to-one-hundred
  (is (has? {:n8n-soak-mix-api-percent 50} "must sum to 100")))

;; --- credentials ------------------------------------------------------------

(deftest the-split-r2-pair-is-preferred-and-the-shared-pair-is-the-fallback
  (let [shared (v/effective-r2 (merge base {:r2-access-key-id "a" :r2-secret-access-key "b"}))
        split  (v/effective-r2 (merge base {:r2-access-key-id "a" :r2-secret-access-key "b"
                                            :neon-r2-access-key-id "c"
                                            :neon-r2-secret-access-key "d"}))]
    (is (false? (:split? shared)))
    (is (= "a" (:access-key-id shared)))
    (is (true? (:split? split)))
    (is (= "c" (:access-key-id split)))))

(deftest the-backup-scoping-gate-is-conditional
  (testing "making it mandatory would fail every converge on the shared
            credential, which is the credential model actually in use"
    (is (false? (v/backup-credential-scoped? base)))
    (is (true? (v/backup-credential-scoped?
                (merge base {:n8n-backup-r2-access-key-id "a"
                             :n8n-backup-r2-secret-access-key "b"}))))))

(deftest the-encryption-key-must-be-long-enough
  (let [creds {:vultr-api-key "v" :cloudflare-api-token "c"
               :r2-access-key-id "a" :r2-secret-access-key "b"}]
    (is (some #(re-find #"at least 32 characters" %)
              (v/secret-errors (merge base creds {:n8n-encryption-key "short"}) :create)))
    (is (empty? (filter #(re-find #"N8N_ENCRYPTION_KEY" %)
                        (v/secret-errors (merge base creds
                                                {:n8n-encryption-key (apply str (repeat 32 "a"))})
                                         :create))))))

(deftest profile-may-not-be-overlaid-from-the-environment
  (is (seq (v/env-errors {v/profile-par "somewhere-else"})))
  (is (empty? (v/env-errors {}))))
