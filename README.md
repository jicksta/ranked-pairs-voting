# Tideman Ranked Pairs Election Algorithm

See [this Wikipedia page](https://en.wikipedia.org/wiki/Ranked_pairs) for a full description of TRP.

This implementation is tested with Ginkgo/Gomega and uses the "workbench" samples from [condorcet.ca](https://condorcet.ca/workbench/workbench-tabs/) to assert this project's results are identical to what that reference implementation generates (thereby also proving their reference implementation is at least as correct as this one).

This implementation was not based on any other code reference: just the Wikipedia article and the *outputs* from condorcet.ca's Java Swing-based vote counter desktop app (no code was found for it).

## Future plans

* Return a more complex data structure for Election Result() that includes everything known internally, including the results DAG
* Document all the things
* Find more gnarly edge cases and write tests for them to guarantee the algorithm works correctly
* Support dynamic ballot collection and result ordering
* Add new package that can read and write to Postgres or LevelDB for persistent dynamic votes
* Support Keybase signature public keys as voter IDs and de-duplicate ballots using public keys
* RESTful and PubSub microservices for realtime voting
