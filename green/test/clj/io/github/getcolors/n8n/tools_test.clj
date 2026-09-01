(ns io.github.getcolors.n8n.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [cheshire.core :as json]
            [io.github.getcolors.n8n.tools :as tools]))

(deftest the-neon-bundle-renders-from-the-dependency-not-a-local-copy
  (testing "every storage-tier template resolves as a namespaced keyword in the
            getcolors.neon namespace. If one of these ever resolves under
            getcolors.n8n, a second copy has appeared and will drift."
    (let [specs (tools/neon-specs "/tmp/stage" {})]
      (is (= 12 (count specs)))
      (doseq [{:keys [template target]} specs]
        (is (str/starts-with? (namespace template) "io.github.getcolors.neon.tools")
            (str template " must come from the neon dependency"))
        (is (str/includes? target "/neon/")
            "the bundle renders into its own directory so relative src: names
             in the upstream play cannot resolve to an n8n file")))))

(deftest the-inventory-places-one-host-in-both-groups
  (testing "the imported neon play targets `neon`, this package's targets
            `n8n`, and both converge the same machine"
    (let [inv (json/parse-string (tools/inventory {:profile "p" :ip "10.0.0.1"}) true)]
      (is (= #{:neon :n8n} (set (keys (get-in inv [:all :children])))))
      (is (contains? (get-in inv [:all :children :neon :hosts]) :p))
      (is (contains? (get-in inv [:all :children :n8n :hosts]) :p))
      (testing "variables are HOST vars, never group vars -- group_vars
                precedence between two groups on one host would be a live hazard"
        (is (= "10.0.0.1" (get-in inv [:all :hosts :p :ansible_host])))
        (is (nil? (get-in inv [:all :children :neon :vars])))
        (is (nil? (get-in inv [:all :children :n8n :vars])))))))

(deftest http-sources-resolve-explicit-lists-verbatim
  (let [{:keys [source ranges]} (tools/http-sources
                                 {:vultr-http-sources ["1.2.3.0/24" "::/0"]})]
    (is (= :explicit source))
    (is (= ["1.2.3.0/24" "::/0"] ranges))))

(deftest the-cloudflare-fallback-is-never-permissive
  (testing "a failed range fetch must not widen to 0.0.0.0/0"
    (is (not-any? #{"0.0.0.0/0" "::/0"} tools/cloudflare-ranges-fallback))
    (is (< 10 (count tools/cloudflare-ranges-fallback)))))

(deftest the-range-checksum-is-order-independent
  (testing "the recorded checksum identifies the SET, so a provider reordering
            its published list is not a firewall change"
    (is (= (tools/ranges-checksum ["a" "b"]) (tools/ranges-checksum ["b" "a"])))
    (is (not= (tools/ranges-checksum ["a" "b"]) (tools/ranges-checksum ["a" "c"])))))

(deftest the-dns-record-is-proxied-with-an-automatic-ttl
  (testing "Cloudflare rejects an explicit TTL on a proxied record, and the
            zone data source is named `zone` with attribute `id` -- both were
            wrong on the first live converge and only failed at apply time"
    (let [doc (json/parse-string
               (tools/dns-json {:n8n-host "n8n.example.com"
                                :ip "203.0.113.5"
                                :cloudflare-proxied true}) true)
          body (get-in doc [:resource :cloudflare_dns_record :n8n])]
      (is (= "${data.cloudflare_zone.zone.id}" (:zone_id body)))
      (is (= "n8n.example.com" (:name body)))
      (is (= 1 (:ttl body)))
      (is (true? (:proxied body))))))
