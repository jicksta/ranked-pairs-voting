package main

import (
  "os"
  "fmt"
  "github.com/jicksta/ranked-pairs-voting"
)

func main() {
  filename := os.Args[1]
  election := trp.LoadElectionFile(filename)
  results, _ := election.Results()

  fmt.Print("Results:\n\n")

  for _, result := range results {
    fmt.Println(result)
  }
}
