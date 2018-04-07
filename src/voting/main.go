package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	set "github.com/deckarep/golang-set"
)

func main() {
	votes := ReadVoteFile("test/fixtures/tennessee.txt")
	candidates := AllCandidates(votes)
	// fmt.Println(candidates)

	pairCounts := make(map[set.OrderedPair]int64)
	for _, vote := range votes {
		pairs := vote.Pairs()
		for _, pair := range pairs {
			pairCounts[pair]++
		}
	}

	wins := make(map[string]int64)
	for _, candidateA := range candidates {
		for _, candidateB := range candidates {
			if candidateB != candidateA {
				favorA := pairCounts[set.OrderedPair{First: candidateA, Second: candidateB}]
				favorB := pairCounts[set.OrderedPair{First: candidateB, Second: candidateA}]
				if favorA > favorB {
					wins[candidateA] += favorA
				} else if favorB > favorA {
					wins[candidateB] += favorB
				} else {
					panic(fmt.Errorf("TODO! TIE BETWEEN %s and %s", candidateA, candidateB))
				}

			}
		}
	}

	fmt.Println(wins)
}

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

type Vote struct {
	voterName     string
	rankedChoices []string
}

func (vote Vote) Pairs() []set.OrderedPair {
	var pairs = make([]set.OrderedPair, 0)
	for indexOuter := range vote.rankedChoices {
		for indexInner := indexOuter + 1; indexInner < len(vote.rankedChoices); indexInner++ {
			pair := set.OrderedPair{First: vote.rankedChoices[indexOuter], Second: vote.rankedChoices[indexInner]}
			pairs = append(pairs, pair)
		}
	}

	return pairs
	// pair1 := set.OrderedPair{First: "foo", Second: "bar"}
	// pair2 := set.OrderedPair{First: "qaz", Second: "qwerty"}
	// return []set.OrderedPair{pair1, pair2}
}

func FakeVotes() []Vote {
	fake1 := Vote{"957294", []string{"G", "E", "A"}}
	fake2 := Vote{"57D522", []string{"A", "G"}}
	return []Vote{fake1, fake2}
}

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

func guard(e error) {
	if e != nil {
		panic(e)
	}
}
