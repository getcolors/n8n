(ns io.github.getcolors.n8n.compute
 (:require [clojure.walk :as walk] [cheshire.core :as json] [clojure.java.io :as io] [clojure.string :as str]
           [green.cli :as cli] [io.github.getcolors.compute :as library]
           [io.github.getcolors.compute-deployment-request :as deployment]
           [io.github.getcolors.compute-planning :as planning]
           [io.github.getcolors.compute-orchestration :as orchestration]
           [io.github.getcolors.compute-inspection :as inspection]))
(defn settings [opts] (walk/postwalk #(if (sequential? %) (vec %) %) opts))
(defn source-cidrs [opts suffix key] (deployment/source-cidrs (settings opts) suffix key))
(def topology [{:count 1}])
(defn ipv4-only
  "The AWS adapter accepts IPv4 sources only, so a symbolic range set loses
  its IPv6 members there. Explicit operator CIDRs are left alone and validate
  against the provider as written."
  [opts ranges]
  (if (= "aws" (:provider-compute opts)) (vec (remove #(str/includes? % ":") ranges)) ranges))
(defn requirements [opts]
 (let [ssh (source-cidrs opts "ssh-sources" "n8n-ssh-sources") http (source-cidrs opts "http-sources" "n8n-http-sources") http (if (= ["cloudflare"] http) (ipv4-only opts (vec (json/parse-string (slurp (io/resource "io/github/getcolors/n8n/origin-ranges.json"))))) http)]
  {:single_host true :security {:egress "all" :private_filter false
   :ingress (into [{:id "ssh" :protocol "tcp" :from_port 22 :to_port 22 :sources ssh}]
                  (map (fn [port] {:id (str "web-" port) :protocol "tcp" :from_port port :to_port port :sources http}) [80 443]))}
   :legacy_state_keys [(str (:profile opts) "/n8n-infrastructure.tfstate")]}))
(defn errors [opts] (try (let [errors (library/validate (settings opts))] (if (seq errors) errors (do (planning/plan-deployment (settings opts) topology (requirements opts)) []))) (catch Exception _ ["invalid singleton compute requirements"])))
(defn attach [opts result]
 (cond
  (not (contains? #{"planned" "ready" "present" "destroyed"} (:status result))) (assoc opts :green/exit 1 :green/err (if (seq (:errors result)) (str/join "\n" (:errors result)) "compute lifecycle refused"))
  (= "destroyed" (:status result)) (assoc opts :green/exit 0 :n8n/already-destroyed true)
  :else (let [cluster (:cluster result) node (first (filter #(= (:node_id %) (:entry_node_id cluster)) (:nodes cluster)))]
    (merge opts node {:green/exit 0 :colors-compute/cluster cluster :colors-compute/key (:key result) :ssh-private-key-path (or (get-in result [:key :private_key_path]) (:ssh_identity_file node))}))))
(defn- compute-json [value indent]
  (let [padding #(apply str (repeat % " "))]
    (cond
      (map? value) (if (empty? value) "{}"
                      (str "{\n" (str/join ",\n" (for [[key item] (sort-by key value)]
                                                       (str (padding (+ indent 2)) (json/generate-string key) ": " (compute-json item (+ indent 2)))))
                           "\n" (padding indent) "}"))
      (sequential? value) (if (empty? value) "[]"
                              (str "[\n" (str/join ",\n" (map #(str (padding (+ indent 2)) (compute-json % (+ indent 2))) value)) "\n" (padding indent) "]"))
      :else (json/generate-string value))))


(defn infrastructure-step
 "Plan on build and dry-run; orchestrate otherwise. `env` is the subprocess
 environment the library hands its providers, so a caller can add AWS
 credentials supplied as COLORS_PAR_AWS_* without exporting them globally."
 ([opts] (infrastructure-step opts (into {} (System/getenv))))
 ([opts env]
 (let [planning? (or (= :build (:green/event opts)) (:green/dry-run opts))
       result (if planning? (planning/plan-deployment (settings opts) topology (requirements opts)) (orchestration/orchestrate (settings opts) topology (requirements opts) env))]
  (when planning?
   (doseq [[stage docs] (cons ["shared" (get-in result [:documents :shared])] (map (fn [[id docs]] [(str "nodes/" (name id)) docs]) (get-in result [:documents :nodes])))
           :let [key (if (= stage "shared") (get-in result [:state_keys :shared]) (get-in result [:state_keys :nodes (last (str/split stage #"/"))]))
                 docs (assoc docs "backend.tf.json" (:config (library/backend-plan opts key)))]
           [filename document] docs]
    (let [target (io/file (cli/stage-dir opts "compute") stage (name filename))]
     (io/make-parents target)
     (spit target (str (compute-json (json/parse-string (json/generate-string document)) 0) "\n")))))
  (attach opts result))))
(defn load-step
 "Read the recorded deployment before a delete. With a managed S3 state bucket
 any status but `present` means the application stages have nothing left to
 act on, and the delete goes straight to backend finalization: the bucket may
 already be half-finalized, or gone, and neither is a compute state to adopt."
 ([opts] (load-step opts (into {} (System/getenv))))
 ([opts env]
  (if (:green/dry-run opts) opts
   (let [result (inspection/read-deployment (settings opts) env {} (requirements opts))]
    (if (and (= "managed" (:s3-bucket-mode opts)) (not= "present" (:status result)))
     (assoc opts :green/exit 0 :n8n/finalize-only true)
     (attach opts result))))))

(defn symbolic-http? [opts] (try (= ["cloudflare"] (source-cidrs opts "http-sources" "n8n-http-sources")) (catch Exception _ false)))
