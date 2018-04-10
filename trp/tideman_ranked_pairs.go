package trp

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

type TidemanRankedPairsElection struct {
	Votes          []Vote
	Candidates     []string
	SourceFilename string
}

type Vote struct {
	VoterID string
	Choices [][]string
}

type OneVersusOneVote struct {
	A      string
	B      string
	FavorA int
	FavorB int
	Ties   int
}

func (vote *Vote) EquivalentRoundRobinVotes() []OneVersusOneVote {
	votes := []OneVersusOneVote{}
	for indexOuter, choiceOuter := range vote.Choices {

		// First, add all ties to the slice we'll return at the end
		for tieOuterIndex := range choiceOuter {
			for tieInnerIndex := tieOuterIndex + 1; tieInnerIndex < len(choiceOuter); tieInnerIndex++ {
				votes = append(votes, OneVersusOneVote{
					A:      choiceOuter[tieOuterIndex],
					B:      choiceOuter[tieInnerIndex],
					FavorA: 0,
					FavorB: 0,
					Ties:   1,
				})
			}
		}

		// Second, add all non-ties across both dimensions (1st dimension = rank, 2nd dimension = file)
		for indexInner := indexOuter + 1; indexInner < len(vote.Choices); indexInner++ {
			for _, eachWinningChoiceOfSamePriority := range choiceOuter {
				for _, eachLosingChoiceOfSamePriority := range vote.Choices[indexInner] {
					// Personal votes are always votes for A, or ties, but never a vote for B over A
					votes = append(votes, OneVersusOneVote{
						A:      eachWinningChoiceOfSamePriority,
						B:      eachLosingChoiceOfSamePriority,
						FavorA: 1,
					})
				}
			}
		}

	}
	return votes
}

// TODO: Try setting Tally to map[string]map[string]*OneVersusOneVote to avoid mutation problems
type Tally map[string]map[string]OneVersusOneVote

func (tally *Tally) Lookup(first, second string) (OneVersusOneVote, string, string) {
	a, b := orderStrings(first, second)
	vote1v1 := (*tally)[a][b]   // Magical instantiation of correct type, or proper lookup if it exists
	vote1v1.A, vote1v1.B = a, b // Auto-initialize these every time, just in case

	if _, exists := (*tally)[a]; !exists {
		(*tally)[a] = map[string]OneVersusOneVote{}
	}

	(*tally)[a][b] = vote1v1
	return vote1v1, a, b
}

func (tally *Tally) incrementWinner(winner, loser string) {
	vote, a, b := tally.Lookup(winner, loser)

	if vote.A == winner {
		vote.FavorA++
	} else if vote.B == winner {
		vote.FavorB++
	} else {
		panic(fmt.Errorf("Invalid winner string given %s for vote with A=%s and B=%s", winner, vote.A, vote.B))
	}

	(*tally)[a][b] = vote
}

func (tally *Tally) incrementTies(first, second string) {
	vote, a, b := tally.Lookup(first, second)
	vote.Ties++
	(*tally)[a][b] = vote
}

func (e *TidemanRankedPairsElection) Tally1v1s() Tally {
	result := make(Tally)

	for _, vote := range e.Votes {
		for _, eachPersonalVote1v1 := range vote.EquivalentRoundRobinVotes() {
			if eachPersonalVote1v1.Ties == 1 {
				result.incrementTies(eachPersonalVote1v1.A, eachPersonalVote1v1.B)
			} else {
				result.incrementWinner(eachPersonalVote1v1.A, eachPersonalVote1v1.B)
			}
		}
	}

	return result
}

func DeserializeFile(filename string) TidemanRankedPairsElection {
	f, err := os.Open(filename)
	defer f.Close()

	guard(err)
	var votes []Vote
	scanner := bufio.NewScanner(bufio.NewReader(f))
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
		votes = append(votes, Vote{
			VoterID: voterID,
			Choices: prioritizedChoices,
		})
	}

	candidatesSet := make(map[string]bool)
	for _, vote := range votes {
		for _, priorityChoices := range vote.Choices {
			for _, choice := range priorityChoices {
				candidatesSet[choice] = true
			}
		}
	}
	var candidates = []string{}
	for key := range candidatesSet {
		candidates = append(candidates, key)
	}
	sort.Strings(candidates) // Remove non-determinism introduced by the map

	return TidemanRankedPairsElection{
		Votes:          votes,
		Candidates:     candidates,
		SourceFilename: filename,
	}
}

func guard(err error) {
	if err != nil {
		panic(err)
	}
}

func orderStrings(one, two string) (string, string) {
	if strings.Compare(one, two) < 0 {
		return one, two
	}
	return two, one
}
