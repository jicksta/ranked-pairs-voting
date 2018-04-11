package main

import (
  "os"
  "fmt"
  "github.com/jicksta/go-ranked-pair-voting/trp"
)

func main() {
  filename := os.Args[1]
  election := trp.LoadElectionFile(filename)
  results, _ := election.Result()

  fmt.Print("Results:\n\n")

  for _, result := range results {
    fmt.Println(result)
  }
}
