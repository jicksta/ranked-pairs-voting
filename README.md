# Tideman Ranked Pairs Election Algorithm

[![GoDoc](https://godoc.org/gonum.org/v1/gonum?status.svg)](https://godoc.org/github.com/jicksta/ranked-pairs-voting)

See [this Wikipedia page](https://en.wikipedia.org/wiki/Ranked_pairs) for a full description of TRP.

This implementation is tested with Ginkgo/Gomega and uses the "workbench" samples from [condorcet.ca](https://condorcet.ca/workbench/workbench-tabs/) to assert this project's results are identical to what that reference implementation generates (thereby also proving their reference implementation is at least as correct as this one).

This implementation was not based on any other code reference: just the Wikipedia article and the *outputs* from condorcet.ca's Java Swing-based vote counter desktop app (no code was found for it).
