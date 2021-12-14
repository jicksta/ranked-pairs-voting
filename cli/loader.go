package main

import (
  "bufio"
  "io"
  "log"
  "os"
  "regexp"
  "strings"
  . "github.com/jicksta/ranked-pairs-voting"

)

// ReadElection deserializes a Election from a Reader using the following format:
//
//     <voterID> <choiceA> <choiceB> <choiceC>
//
// Ties can be expressed as <choiceA>=<choiceB>. For example:
//
//     VOTER_JAY  Finn=Jake  Bubblegum=Lemongrab  Marceline  IceKing
//
// In this example above, Finn and Jake are tied for 1st place, Bubblegum and Lemongrab
// are tied for 2nd, and Marceline and IceKing are 3rd and 4th places, respectively.
//
// The electionID param is only used for reporting purposes. It can be any string.
func ReadElection(electionID string, reader io.Reader) (*Election, error) {
  var ballots []*Ballot
  scanner := bufio.NewScanner(reader)
  whitespaceSeparator := regexp.MustCompile("\\s+")
  for scanner.Scan() {
    nextLine := scanner.Text()
    nonWhitespaceTokens := whitespaceSeparator.Split(nextLine, -1)
    voterID := nonWhitespaceTokens[0]
    var prioritizedChoices [][]string
    for _, token := range nonWhitespaceTokens[1:] {
      potentialTies := strings.Split(token, "=")
      prioritizedChoices = append(prioritizedChoices, potentialTies)
    }
    ballots = append(ballots, &Ballot{
      VoterID:    voterID,
      Priorities: prioritizedChoices,
    })
  }

  return NewElection(electionID, ballots), nil
}

func electionFromFile(filename string) *Election {
  f, err := os.Open(filename)
  if err != nil {
    log.Fatal("Error: Could not open file at " + filename)
  }
  defer f.Close()
  if election, err := ReadElection(filename, f); err == nil {
    return election
  } else {
    log.Fatal("Error: Unable to process " + filename)
    return nil
  }
}
