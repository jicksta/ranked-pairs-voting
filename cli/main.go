package main

import (
  "github.com/jicksta/ranked-pairs-voting"
  "fmt"
  "os"
  "time"
)

func main() {
  startTime := time.Now()
  election := electionFromFile(os.Args[1])
  results := election.Results()
  executionDuration := time.Now().Sub(startTime)

  fmt.Print("Results:\n\n")
  for n, result := range results.Winners {
    fmt.Printf(" %2d. %s\n", n+1, result)
  }

  fmt.Printf(`
Number of choices: %d
Number of votes:   %d
Time to calculate: %s

Algorithm: Tideman Ranked Pairs (TRP)
Number of cyclical locked pairs: %d`,
    len(election.Choices),
    len(election.Ballots),
    executionDuration,
    len(results.RankedPairs.CyclicalLockedPairsIndices))

  fmt.Print("\n\n\nRanked Pairs Data:\n\n")
  results.RankedPairs.PrintTable(os.Stdout)

  fmt.Print("\n\nTally Data:\n\n")
  results.PrintTally(os.Stdout)

  fmt.Println(`
The tally data contains information about the 1:1 "runoff" elections that Ranked Pairs simulates, consistent with the
Condorcet criterion. A table cell with the following text "A=3  B=2  (1)" would indicate that, in a runoff election
between A and B, there are 3 votes for A over B, 2 votes for B over A, and 1 tie. A and B refer to the names listed in
the column and row headers.`)

}

func electionFromFile(filename string) *trp.CompletedElection {
  f, err := os.Open(filename)
  if err != nil {
    panic(err)
  }
  defer f.Close()
  if election, err := trp.ReadElection(f); err == nil {
    return election
  } else {
    panic(err)
  }
}
