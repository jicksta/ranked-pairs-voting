package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"

	set "github.com/deckarep/golang-set"
	toposort "github.com/philopon/go-toposort"
)

func main() {
	votes := ReadVoteFile("test/fixtures/tennessee.txt")
	// votes := ReadVoteFile("votes.txt")
	candidates := AllCandidates(votes)
	// fmt.Println(candidates)

	pairCounts := make(map[set.OrderedPair]int64)
	for _, vote := range votes {
		pairs := vote.Pairs()
		for _, pair := range pairs {
			pairCounts[pair]++
		}
	}

	var relativeWinnerSet = set.NewSet()
	for _, candidateA := range candidates {
		for _, candidateB := range candidates {
			if candidateB != candidateA {
				favorA := pairCounts[newPair(candidateA, candidateB)]
				favorB := pairCounts[newPair(candidateB, candidateA)]
				if favorA > favorB {
					relativeWinnerSet.Add(RelativeWinner{
						winner:      candidateA,
						loser:       candidateB,
						winnerCount: favorA,
						loserCount:  favorB,
					})
				} else if favorB > favorA {
					relativeWinnerSet.Add(RelativeWinner{
						winner:      candidateB,
						loser:       candidateA,
						winnerCount: favorB,
						loserCount:  favorA,
					})
				} else {
					panic(fmt.Errorf("TODO! TIE BETWEEN %s and %s", candidateA, candidateB))
				}

			}
		}
	}

	var relativeWinners = make([]RelativeWinner, 0)
	for _, winnerMaybe := range relativeWinnerSet.ToSlice() {
		if winner, ok := winnerMaybe.(RelativeWinner); ok {
			relativeWinners = append(relativeWinners, winner)
		}
	}

	sort.SliceStable(relativeWinners, func(i int, j int) bool {
		return relativeWinners[i].winnerCount > relativeWinners[j].winnerCount
	})

	// var lockedDAGPairs = make([]set.OrderedPair, 0)
	// for _, relWinner := range relativeWinners {
	// 	lockedDAGPairs = append(lockedDAGPairs, newPair(relWinner.winner, relWinner.loser))
	// }
	// fmt.Println(GraphVizDotFile(lockedDAGPairs))

	dag := toposort.NewGraph(len(relativeWinners))
	dag.AddNodes(candidates...)
	for _, relWinner := range relativeWinners {
		dag.AddEdge(relWinner.winner, relWinner.loser)
	}
	finalWinners, _ := dag.Toposort()

	fmt.Print("Ranked Pair winners:\n\n")
	for _, finalWinner := range finalWinners {
		fmt.Println(finalWinner)
	}
}

// GraphVizDotFile returns the string contents of a .dot GraphViz file representing the DAG of winners
func GraphVizDotFile(pairs []set.OrderedPair) string {
	var dot = "digraph Election {\n"
	for _, pair := range pairs {
		dot += fmt.Sprintf("  \"%s\" -> \"%s\";\n", pair.First, pair.Second)

	}
	dot += "}"
	return dot
}

// RelativeWinner is used in the counting process, particularly for sorting
type RelativeWinner struct {
	winner      string
	loser       string
	winnerCount int64
	loserCount  int64
}

func (relWinner RelativeWinner) String() string {
	return fmt.Sprintf("%s (%d) vs %s (%d)", relWinner.winner, relWinner.winnerCount, relWinner.loser, relWinner.loserCount)
}

// AllCandidates is a utility method that returns a distinct list of candidates observed in a Vote array
func AllCandidates(votes []Vote) []string {
	distinctCandidatesSet := set.NewSet()
	for _, vote := range votes {
		for _, choice := range vote.rankedChoices {
			distinctCandidatesSet.Add(choice)
		}
	}
	var candidates = make([]string, 0)
	for candidateUntyped := range distinctCandidatesSet.Iter() {
		if candidate, ok := candidateUntyped.(string); ok {
			candidates = append(candidates, candidate)
		}
	}
	return candidates
}

// Vote records which voter voted for which candidates
type Vote struct {
	voterName     string
	rankedChoices []string
}

// Pairs returns relative winners from rankedChoices as tuples (winner, loser)
func (vote Vote) Pairs() []set.OrderedPair {
	var pairs = make([]set.OrderedPair, 0)
	for indexOuter := range vote.rankedChoices {
		for indexInner := indexOuter + 1; indexInner < len(vote.rankedChoices); indexInner++ {
			pair := newPair(vote.rankedChoices[indexOuter], vote.rankedChoices[indexInner])
			pairs = append(pairs, pair)
		}
	}

	return pairs
}

// ReadVoteFile returns an array of Votes deserialized from a simple .txt file format
func ReadVoteFile(filename string) []Vote {
	file, err := os.Open(filename)
	guard(err)

	var votes []Vote
	scanner := bufio.NewScanner(bufio.NewReader(file))
	for scanner.Scan() {
		tokens := strings.Split(scanner.Text(), " ")
		votes = append(votes, Vote{tokens[0], tokens[1:]})
	}
	return votes
}

func newPair(first string, second string) set.OrderedPair {
	return set.OrderedPair{First: first, Second: second}
}

func guard(e error) {
	if e != nil {
		panic(e)
	}
}
