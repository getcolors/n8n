(ns io.github.getcolors.n8n.workflow-test
  "The graph: which stages run, in which order, under which desired state."
  (:require [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.n8n.workflow :as w]))

(defn successors [step run-opts] (vec (rest (w/wire-fn step run-opts))))

(deftest the-unmanaged-graph-is-unchanged
  (let [create {:green/event :create} delete {:green/event :delete}]
    (is (= [:n8n/infrastructure] (successors :n8n/start create)))
    (is (= [:n8n/dns] (successors :n8n/infrastructure create)))
    (is (= [:n8n/ssh-config] (successors :n8n/dns create)))
    (is (= [:n8n/ansible] (successors :n8n/ssh-config create)))
    (is (= [:n8n/acceptance] (successors :n8n/ansible create)))
    (is (= [:n8n/load] (successors :n8n/start delete)))
    (is (= [:n8n/ansible] (successors :n8n/load delete)))
    (is (= [:n8n/infrastructure] (successors :n8n/dns delete)))
    (is (= [] (successors :n8n/infrastructure delete)))))

(deftest managed-storage-sits-between-compute-and-dns
  (let [create {:green/event :create :n8n-storage-managed true :s3-bucket-mode "managed"}
        delete (assoc create :green/event :delete)]
    (testing "create: infrastructure, storage, dns"
      (is (= [:n8n/storage] (successors :n8n/infrastructure create)))
      (is (= [:n8n/dns] (successors :n8n/storage create))))
    (testing "delete: dns, storage, infrastructure, then the state bucket last of all"
      (is (= [:n8n/storage] (successors :n8n/dns delete)))
      (is (= [:n8n/infrastructure] (successors :n8n/storage delete)))
      (is (= [:n8n/backend-finalize] (successors :n8n/infrastructure delete)))
      (is (= [] (successors :n8n/backend-finalize delete))))))

(deftest a-managed-state-bucket-is-finalized-even-without-managed-storage
  (let [delete {:green/event :delete :s3-bucket-mode "managed"}]
    (is (= [:n8n/infrastructure] (successors :n8n/dns delete)))
    (is (= [:n8n/backend-finalize] (successors :n8n/infrastructure delete)))))

(deftest a-delete-that-finds-no-live-compute-goes-straight-to-finalization
  (testing "the load step marks it; the router honours the mark only there"
    (is (= [[:n8n/backend-finalize {:n8n/finalize-only true}]]
           (w/next-fn :n8n/load [:n8n/ansible] {:n8n/finalize-only true})))
    (is (= [[:n8n/ansible {}]] (w/next-fn :n8n/load [:n8n/ansible] {})))
    (is (= [] (w/next-fn :n8n/ansible [:n8n/ssh-config] {:green/exit 1})))))

(deftest every-new-stage-is-skipped-by-dry-run
  (is (some #{:n8n/storage} w/side-effecting))
  (is (some #{:n8n/backend-finalize} w/side-effecting)))
