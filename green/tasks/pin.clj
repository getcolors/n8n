(ns pin (:require [clojure.java.shell :as sh] [clojure.string :as str]))
;; One SHA, three payloads. Every payload is born unpinned -- no invented SHAs --
;; and `bb pin` stamps or re-stamps it after a clean, pushed HEAD. Each site
;; recognises exactly two forms, its unpinned birth shape and its pinned shape,
;; and the run fails loudly when a payload matches neither.
;;
;; Only this repository's own SHA is written here. The pins this package depends
;; on -- green, once, neon, red, blue -- are edited by hand in deps.edn,
;; red/package.json, blue/pyproject.toml and the red payload's PINS, and
;; scripts/launcher.sh checks that the neon pin agrees across all four.
(defn git [& args] (let [{:keys [exit out]} (apply sh/sh "git" args)] (when (zero? exit) (str/trim out))))

(defn stamp-green [s sha]
  (when (re-find #"\(def \^:private n8n-sha (?:nil|\"[0-9a-f]{40}\")\)" s)
    (str/replace-first s #"\(def \^:private n8n-sha (?:nil|\"[0-9a-f]{40}\")\)"
                       (str "(def ^:private n8n-sha \"" sha "\")"))))

(defn stamp-red [s sha]
  (let [pinned (str "\"package-n8n-red\": \"github:getcolors/n8n#" sha "\",")]
    (cond (str/includes? s "\"package-n8n-red\": null,")
          (str/replace-first s "\"package-n8n-red\": null," pinned)
          (re-find #"\"package-n8n-red\": \"github:getcolors/n8n#[0-9a-f]{40}\"," s)
          (str/replace-first s #"\"package-n8n-red\": \"github:getcolors/n8n#[0-9a-f]{40}\"," pinned))))

;; The blue payload's PEP 723 block must name every source itself. uv applies a
;; project's own `[tool.uv.sources]`, and a script's, but nothing here may
;; depend on it reading them out of a dependency -- so the storage tier and
;; ONCE are declared beside this package rather than left to resolution.
(def blue-unpinned-meta "# dependencies = []\n# ///")
(defn blue-pinned-meta [sha]
  (str "# dependencies = [\"package-n8n-blue\", \"blue\"]\n"
       "#\n"
       "# [tool.uv.sources]\n"
       "# package-n8n-blue = { git = \"https://github.com/getcolors/n8n.git\", rev = \"" sha "\", subdirectory = \"blue\" }\n"
       "# package-neon-blue = { git = \"https://github.com/getcolors/neon.git\", rev = \"87c009549a928fdf1f9dc135f9740c3baa5782d7\", subdirectory = \"blue\" }\n"
       "# package-once-blue = { git = \"https://github.com/getcolors/once.git\", rev = \"759eb0311b4bdf881eab813cfe5d00f76b9310cc\", subdirectory = \"blue\" }\n"
       "# blue = { git = \"https://github.com/getcolors/blue.git\", rev = \"290f313ead5ca162875c33a049c880da017eae09\" }\n"
       "#\n"
       ;; package-once-blue and package-neon-blue carry their own, older blue
       ;; pins; the override makes this package's blue pin win, as it does in
       ;; blue/pyproject.toml.
       "# [tool.uv]\n"
       "# override-dependencies = [\"blue @ git+https://github.com/getcolors/blue.git@290f313ead5ca162875c33a049c880da017eae09\"]\n"
       "# ///"))
(defn stamp-blue [s sha]
  ;; First stamp is structural: the metadata block gains its git sources and the
  ;; UNPINNED paragraph collapses to a pinned-state note. Re-pinning is a SHA swap.
  (cond (str/includes? s blue-unpinned-meta)
        (-> s
            (str/replace-first blue-unpinned-meta (blue-pinned-meta sha))
            (str/replace-first #"(?s)# UNPINNED:.*?N8N_LIB_ROOT=/path/to/n8n\n"
                               "# Stamped by `bb pin`. N8N_LIB_ROOT=/path/to/n8n still overrides the\n# pin with a working tree.\n"))
        (re-find #"n8n\.git\", rev = \"[0-9a-f]{40}\"" s)
        (str/replace-first s #"n8n\.git\", rev = \"[0-9a-f]{40}\""
                           (str "n8n.git\", rev = \"" sha "\""))))

(def sites
  [{:path "../skills/package-n8n-green/green" :stamp stamp-green}
   {:path "../skills/package-n8n-red/red" :stamp stamp-red}
   {:path "../skills/package-n8n-blue/blue" :stamp stamp-blue}])

(let [dirty (git "status" "--porcelain") sha (git "rev-parse" "HEAD") remotes (git "branch" "-r" "--contains" sha)]
  (cond (seq dirty)
        (do (binding [*out* *err*] (println "n8n working tree is dirty; commit before pinning")) (System/exit 2))
        (not (str/includes? (str remotes) "origin/"))
        (do (binding [*out* *err*] (println "n8n HEAD is not pushed")) (System/exit 2))
        :else
        (let [errors (atom [])]
          (doseq [{:keys [path stamp]} sites]
            (let [s (slurp path) n (stamp s sha)]
              (if n (spit path n) (swap! errors conj (str "could not locate a pin form in " path)))))
          (if (seq @errors)
            (do (binding [*out* *err*] (println (str/join "\n" @errors))) (System/exit 2))
            (println "pinned 3 launchers to" (subs sha 0 7))))))
