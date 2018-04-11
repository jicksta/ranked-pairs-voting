package trp

import (
  "fmt"
  "strings"
  "regexp"
  "sort"
  "os"
  "bufio"
)

type TidemanRankedPairsElection struct {
  Ballots        []Ballot
  Candidates     []string
  SourceFilename string
}

type Ballot struct {
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

type VotesList []OneVersusOneVote

type DroppedVote struct {
  // IndexDroppedAt refers to the index in the magnitude-sorted intermediate list of votes, not the final tsorted-results
  IndexDroppedAt int
  Vote           OneVersusOneVote
}
type tally map[string]map[string]*OneVersusOneVote

// Result returns a one-dimensional sorted list of candidates. In the future it may return a two-dimensional array to account for ties
func (e *TidemanRankedPairsElection) Result() ([]string, []DroppedVote) {
  tally := e.tally1v1s()
  sorted := tally.sortedByMagnitudeVictory()
  return sorted.tsort()
}

func (e *TidemanRankedPairsElection) tally1v1s() tally {
  result := make(tally)

  for _, ballot := range e.Ballots {
    for _, eachBallotVote1v1 := range ballot.equivalentRoundRobinVotes() {
      if eachBallotVote1v1.Ties == 1 {
        result.incrementTies(eachBallotVote1v1.A, eachBallotVote1v1.B)
      } else {
        result.incrementWinner(eachBallotVote1v1.A, eachBallotVote1v1.B)
      }
    }
  }

  return result
}

func (ballot *Ballot) equivalentRoundRobinVotes() []OneVersusOneVote {
  var votes []OneVersusOneVote
  for indexOuter, choiceOuter := range ballot.Choices {

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
    for indexInner := indexOuter + 1; indexInner < len(ballot.Choices); indexInner++ {
      for _, eachWinningChoiceOfSamePriority := range choiceOuter {
        for _, eachLosingChoiceOfSamePriority := range ballot.Choices[indexInner] {
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

func (vote *OneVersusOneVote) victoryMagnitude() int {
  var delta = vote.FavorA - vote.FavorB
  if delta < 0 {
    delta = -delta
  }
  return delta
}

func (t *tally) lookup(first, second string) *OneVersusOneVote {
  a, b := orderStrings(first, second)

  if _, exists := (*t)[a]; !exists {
    (*t)[a] = map[string]*OneVersusOneVote{}
  }

  var vote1v1 = (*t)[a][b]
  if vote1v1 == nil {
    vote1v1 = &OneVersusOneVote{A: a, B: b}
    (*t)[a][b] = vote1v1
  }

  return vote1v1
}

func (t *tally) incrementWinner(winner, loser string) {
  vote := t.lookup(winner, loser)

  if vote.A == winner {
    vote.FavorA++
  } else if vote.B == winner {
    vote.FavorB++
  } else {
    panic(fmt.Errorf("invalid winner string given %s for vote with A=%s and B=%s", winner, vote.A, vote.B))
  }
}

func (t *tally) incrementTies(first, second string) {
  vote := t.lookup(first, second)
  vote.Ties++
}

func (t *tally) sortedByMagnitudeVictory() VotesList {
  var result []OneVersusOneVote // don't use pointer array: copy into result because we mutate FavorA and FavorB
  for aKey := range *t {
    for bKey := range (*t)[aKey] {
      result = append(result, *(*t)[aKey][bKey])
    }
  }

  // For final counting purposes, we should add ties to both FavorA and FavorB
  for i, vote := range result {
    vote.FavorA += vote.Ties
    vote.FavorB += vote.Ties
    result[i] = vote
  }

  sort.SliceStable(result, func(i int, j int) bool {
    leftVote, rightVote := result[i], result[j]
    return leftVote.victoryMagnitude() >= rightVote.victoryMagnitude()
  })

  return result
}

func (votes *VotesList) tsort() ([]string, []DroppedVote) {

  builder := NewDAGBuilder()
  var dropped []DroppedVote

  for i, vote := range *votes {
    if vote.FavorA > vote.FavorB {
      if err := builder.AddEdge(vote.A, vote.B); err != nil {
        dropped = append(dropped, DroppedVote{i, vote})
      }
    } else if vote.FavorB > vote.FavorA {
      if err := builder.AddEdge(vote.B, vote.A); err != nil {
        dropped = append(dropped, DroppedVote{i, vote})
      }
    } else {
      // We got a tie. Try drawing directions between both

      abEdgeErr := builder.AddEdge(vote.A, vote.B)
      baEdgeErr := builder.AddEdge(vote.B, vote.A)

      if abEdgeErr != nil || baEdgeErr != nil {
        dropped = append(dropped, DroppedVote{i, vote})
      }
    }
  }

  return builder.TSort(), dropped
}

func LoadElectionFile(filename string) TidemanRankedPairsElection {
  f, err := os.Open(filename)
  if err != nil {
    panic(err)
  }
  defer f.Close()

  var ballots []Ballot
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
    ballots = append(ballots, Ballot{
      VoterID: voterID,
      Choices: prioritizedChoices,
    })
  }

  candidatesSet := make(map[string]bool)
  for _, vote := range ballots {
    for _, priorityChoices := range vote.Choices {
      for _, choice := range priorityChoices {
        candidatesSet[choice] = true
      }
    }
  }
  var candidates []string
  for key := range candidatesSet {
    candidates = append(candidates, key)
  }
  sort.Strings(candidates) // Remove non-determinism introduced by the map

  return TidemanRankedPairsElection{
    Ballots:        ballots,
    Candidates:     candidates,
    SourceFilename: filename,
  }
}

func orderStrings(one, two string) (string, string) {
  if strings.Compare(one, two) < 0 {
    return one, two
  }
  return two, one
}
