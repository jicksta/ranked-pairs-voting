package main

import (
	"fmt"

	"github.com/jicksta/go-ranked-pair-voting/voting"
)

func main() {
	// votes := ReadVoteFile("test/fixtures/tennessee.txt")
	election := voting.LoadElectionFromFile("votes.txt")

	fmt.Println(voting.GraphVizDotFile(election.Ranks()))

	// dag := toposort.NewGraph(len(relativeWinners))
	// dag.AddNodes(candidates...)
	// for _, relWinner := range relativeWinners {
	// 	dag.AddEdge(relWinner.winner, relWinner.loser)
	// }
	// finalWinners, _ := dag.Toposort()

	// fmt.Print("Ranked Pair winners:\n\n")
	// for _, finalWinner := range finalWinners {
	// 	fmt.Println(finalWinner)
	// }
}
