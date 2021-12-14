package main

import (
	"github.com/gopherjs/gopherjs/js"
	trp "github.com/jicksta/ranked-pairs-voting"
	// "github.com/gopherjs/jsbuiltin"
)

type Votes map[string][][]string
type Winners [][]string

func main() {
	js.Global.Set("TRP", TRP)
}

func TRP(votes Votes) Winners {
	var ballots = make([]*trp.Ballot, 0, len(votes))
	for voterID, priorities := range votes {
		ballots = append(ballots, &trp.Ballot{VoterID: voterID, Priorities: priorities})
	}
	election := trp.NewElection("Election", ballots)
	return election.Results().Winners()
}

/*
func log(message interface{}) {
  js.Global.Get("console").Call("log", message)
}

func stringify(thing interface{}) string {
  return js.Global.Get("JSON").Call("stringify", thing).String()
}
*/
