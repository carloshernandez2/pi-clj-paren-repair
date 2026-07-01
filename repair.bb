#!/usr/bin/env bb
;; clj-paren-repair — delimiter detection & repair for Clojure(ClojureScript) source.
;;
;; Reads code from stdin, fixes unbalanced delimiters via parinfer-rust,
;; then formats with cljfmt, writes result to stdout.
;; Exit 0 = success (content may be unchanged), exit 2 = internal error.
;;
;; edamame is bundled with babashka for delimiter detection.

(ns repair
  (:require [edamame.core :as e]
            [cljfmt.core :as cljfmt]
            [cljfmt.config :as cfg]
            [clojure.java.shell :as shell]))

;; ── delimiter detection ──────────────────────────────────────────────

(defn- delimiter-error?
  "Return truthy when `s` has unbalanced delimiters (not other parse errors)."
  [s]
  (try
    (e/parse-string-all s {:all true
                           :read-cond :allow
                           :features #{:bb :clj :cljs :cljr :default}
                           :readers (fn [_tag] (fn [data] data))
                           :auto-resolve name})
    false
    (catch clojure.lang.ExceptionInfo ex
      (let [data (ex-data ex)]
        (and (= :edamame/error (:type data))
             (contains? data :edamame/opened-delimiter))))
    (catch Exception _
      ;; On any other parse failure, conservatively signal true so parinfer runs.
      ;; Parinfer is a benign no-op when there are no real delimiter issues.
      true)))

;; ── repair ───────────────────────────────────────────────────────────

(defn- fix-delimiters
  "Return repaired string or nil if unfixable."
  [s]
  (when (delimiter-error? s)
    (try
      (let [{:keys [exit out]} (shell/sh "parinfer-rust"
                                         "--mode" "indent"
                                         "--language" "clojure"
                                         :in s)]
        (when (zero? exit)
          ;; Verify the repair actually resolved the problem
          (when-not (delimiter-error? out)
            out)))
      (catch Exception _
        nil))))

;; ── formatting ───────────────────────────────────────────────────────

(defn- load-cljfmt-config
  "Load cljfmt config from the directory of `file-path`.
   Falls back to default config on any error."
  [file-path]
  (try
    (when file-path
      (cfg/load-config (.. file-path java.io.File. getParent)))
    (catch Exception _
      nil)))

(defn- format-code
  "Run cljfmt on `s` with config from `file-path`.
   Returns formatted string, or original on failure."
  [s file-path]
  (try
    (let [config (load-cljfmt-config file-path)]
      (cljfmt/reformat-string s config))
    (catch Exception _
      s)))

;; ── main ─────────────────────────────────────────────────────────────

(try
  (let [file-path (System/getenv "CLJ_FILE_PATH")
        input (slurp *in*)
        fixed (or (fix-delimiters input) input)
        output (format-code fixed file-path)]
    (print output)
    (flush)
    (System/exit 0))
  (catch Exception _
    (System/exit 2)))
