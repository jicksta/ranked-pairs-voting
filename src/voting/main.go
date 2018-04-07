package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	set "github.com/deckarep/golang-set"
)

func main() {
	votes := ReadVoteFile("votes.txt")
	candidates := AllCandidates(votes)
	fmt.Println(candidates)
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
		candidate, ok := candidateUntyped.(string)
		if ok {
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
	pair1 := set.OrderedPair{First: "foo", Second: "bar"}
	pair2 := set.OrderedPair{First: "qaz", Second: "qwerty"}
	return []set.OrderedPair{pair1, pair2}
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
