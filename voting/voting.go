package voting

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"

	mapset "github.com/deckarep/golang-set"
)

// Election encapsulates immutable state about finalized data and vote-counting behavior
type Election struct {
	Votes          []Vote
	Candidates     []string
	SourceFileName string
}

// RelativeWinner is used in the counting process, particularly for sorting
type RelativeWinner struct {
	winner      string
	loser       string
	winnerCount int
	loserCount  int
}

// OneVersusOneResult is a ternary enum to record the final result of
// a hypothetical 1v1 condorcet "instant round-robin" election
type OneVersusOneResult byte

const (
	// A_TIES_B used in OneVersusOneResult
	A_TIES_B = 0
	// A_BEATS_B used in OneVersusOneResult
	A_BEATS_B = 1
	// B_BEATS_A used in OneVersusOneResult
	B_BEATS_A = 2
)

type OneVersusOneTally struct {
	A         string
	B         string
	NumFavorA int
	NumFavorB int
	NumTies   int
	Result    OneVersusOneResult
	// Magnitude float32 // Uncertain whether this will be needed in the end
}

//////////
///// VOTE
//////////

// Vote records which voter voted for which candidates
type Vote struct {
	voterName     string
	rankedChoices []string
}

// combinatorialPreferences returns all voters' winners from their vote's rankedChoices
// as tuples (winner, loser).
// TODO!!! THIS MUST CONSIDER TIES IN THE DATA
func (vote Vote) combinatorialPreferences() []mapset.OrderedPair {

	// If there is a tie, candidates at the same rank

	var pairs = make([]mapset.OrderedPair, 0)
	for indexOuter := range vote.rankedChoices {
		for indexInner := indexOuter + 1; indexInner < len(vote.rankedChoices); indexInner++ {
			pair := newPair(vote.rankedChoices[indexOuter], vote.rankedChoices[indexInner])
			pairs = append(pairs, pair)
		}
	}

	return pairs
}

//////////
///// ELECTION
//////////

// // CondorcetComparisonCounts returns an important data structure for the algorithm: a tally of all
// // votes if all candidates ran against each other.
// func (election Election) CondorcetComparisonCounts() map[mapset.OrderedPair]int {
// 	counts := make(map[mapset.OrderedPair]int)
// 	for _, vote := range election.Votes {
// 		pairs := vote.combinatorialPreferences()
// 		for _, pair := range pairs {
// 			counts[pair]++
// 		}
// 	}
// 	return counts
// }

// CondorcetComparisonCounts returns an important data structure for the algorithm: a tally of all
// votes if all candidates ran against each other.
func (election Election) CondorcetComparisonCounts() map[mapset.OrderedPair]int {
	counts := make(map[mapset.OrderedPair]int)
	for _, vote := range election.Votes {
		pairs := vote.combinatorialPreferences()
		for _, pair := range pairs {
			counts[pair]++
		}
	}
	return counts
}

// Ranks returns an array of all candidates compared against each other, with the winner decided
func (election Election) Ranks() []RelativeWinner {
	pairCounts := election.CondorcetComparisonCounts()

	// Using a set here isn't great. The loops should visit each combination (A,B) and (B,A) once.
	var relativeWinnerSet = mapset.NewSet()

	// Compare all candidates against each other O(n^2 - n)
	for _, candidateA := range election.Candidates {
		for _, candidateB := range election.Candidates {
			if candidateB != candidateA {

				// Lookup the counts of how many times candidate A beat candidate B and vice versa
				favorA := pairCounts[newPair(candidateA, candidateB)]
				favorB := pairCounts[newPair(candidateB, candidateA)]

				relativeWinnerSet.Add(OneVersusOneTally{
					A:         candidateA,
					B:         candidateB,
					NumFavorA: favorA,
					NumFavorB: favorB,
				})

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

	// Remove non-determinism from the map by sorting lexicographically in the event of a tie
	sort.SliceStable(relativeWinners, func(i int, j int) bool {
		countLeft, countRight := relativeWinners[i].winnerCount, relativeWinners[j].winnerCount
		if countLeft == countRight {
			lexicographicalWinner := strings.Compare(relativeWinners[i].winner, relativeWinners[j].winner)
			return lexicographicalWinner > 0
		}
		return relativeWinners[i].winnerCount > relativeWinners[j].winnerCount
	})

	return relativeWinners
}

//////////
///// UTILITY
//////////

func (rw RelativeWinner) String() string {
	return fmt.Sprintf("%s (%d) vs %s (%d)", rw.winner, rw.winnerCount, rw.loser, rw.loserCount)
}

// GraphVizDotFile returns the string contents of a .dot GraphViz file representing the DAG of winners
func GraphVizDotFile(pairs []RelativeWinner) string {
	var dot = "digraph Election {\n"
	for _, pair := range pairs {
		dot += fmt.Sprintf("  \"%s\" -> \"%s\";\n", pair.winner, pair.loser)

	}
	dot += "}"
	return dot
}

// LoadElectionFromFile loads votes from a file and pre-computes some important data from them.
func LoadElectionFromFile(filename string) Election {
	votes := readVoteFile(filename)
	candidates := distinctCandidates(votes)
	return Election{
		Votes:          votes,
		Candidates:     candidates,
		SourceFileName: filename,
	}
}

// readVoteFile returns an array of Votes deserialized from a simple .txt file format
func readVoteFile(filename string) []Vote {
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

// distinctCandidates is a utility method that returns a distinct list of candidates observed in a Vote array
func distinctCandidates(votes []Vote) []string {
	distinctCandidatesSet := mapset.NewSet()
	for _, vote := range votes {
		for _, choice := range vote.rankedChoices {
			distinctCandidatesSet.Add(choice)
		}
	}
	// Coerce members of the set back to strings
	var candidates = make([]string, 0)
	for candidateUntyped := range distinctCandidatesSet.Iter() {
		if candidate, ok := candidateUntyped.(string); ok {
			candidates = append(candidates, candidate)
		}
	}
	return candidates
}

func newPair(first string, second string) mapset.OrderedPair {
	return mapset.OrderedPair{First: first, Second: second}
}

func guard(e error) {
	if e != nil {
		panic(e)
	}
}

func orderedStrings(one, two string) mapset.OrderedPair {
	switch strings.Compare(one, two) {
	case -1:
		return newPair(one, two)
	case 1:
		return newPair(two, one)
	default:
		panic(fmt.Errorf("CANNOT ORDER IDENTICAL STRINGS. LOGIC ERROR? '%s' and '%s'", one, two))
	}
}
