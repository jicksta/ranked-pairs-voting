
# Next steps

 * Break up the big file into sub-packages
 * Write tests
 * Handle tie-breakers and validate implementation with other implementations
 * Separate Repository in preparation for a database
 * Integrate with Postgres / LevelDB or another SQL database for persistence
 * When receiving votes in realtime, run cancellable calculation in goroutine

## Even Better...

 * Use pubkeys as voter IDs (and eventually election validation) and signed votes
 * Create gRPC web service that receives votes and allows admins to manage votes
 * Port logic to go-ethereum
