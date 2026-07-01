#!/usr/bin/env bb
;; clj-paren-repair — delimiter detection & repair for Clojure(ClojureScript) source.
;;
;; Reads code from stdin, fixes unbalanced delimiters via parinfer-rust,
;; writes result to stdout.
;; Exit 0 = success (content may be unchanged), exit 2 = internal error.
;;
;; edamame is bundled with babashka for delimiter detection.

(ns repair
  (:require [edamame.core :as e]
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

;; ── main ─────────────────────────────────────────────────────────────

(try
  (let [input (slurp *in*)
        output (or (fix-delimiters input) input)]
    (print output)
    (flush)
    (System/exit 0))
  (catch Exception _
    (System/exit 2)))
