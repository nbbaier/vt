# Three-Way Diffing — Design Decision Log

This folder records the decisions made while turning the exploratory brainstorm
in [`../three-way-diffing.md`](../three-way-diffing.md) into an actual
implementation. Each entry is a small decision record: the context, the
decision, the alternatives that were rejected, and the consequences.

Entries are numbered in the order the decisions were made and are not rewritten
after the fact — if a decision is reversed later, a new entry supersedes the old
one and links back.

| #    | Decision                                                                                              | Status   |
| ---- | ----------------------------------------------------------------------------------------------------- | -------- |
| 0001 | [Scope: implement phases 1–3 together](0001-scope-and-phasing.md)                                     | accepted |
| 0002 | [Merge base comes from remote version history](0002-merge-base-from-version-history.md)               | accepted |
| 0003 | [Explicit conflict status + direction on every change](0003-conflict-and-direction-representation.md) | accepted |
| 0004 | [Classifier is a pure, synchronous function](0004-pure-classifier.md)                                 | accepted |
| 0005 | [Pull merge semantics and conflict markers](0005-pull-merge-semantics.md)                             | accepted |
| 0006 | [Push only local-side changes; markers gate push](0006-push-safety.md)                                | accepted |
| 0007 | [diff3 via the `node-diff3` npm package](0007-diff3-dependency.md)                                    | accepted |
| 0008 | [Degradation, compatibility, and known limitations](0008-compatibility-and-degradation.md)            | accepted |
| 0009 | [Push must not advance the base past unincorporated remote changes](0009-push-base-advance.md)        | accepted |
