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
  Choices        []string
  SourceFilename string
}

// Ballot represents an individual voter's preferences. Priorities are represented as a two-dimensional
// slice because there can be ties between choices at the same priority.
type Ballot struct {
  VoterID    string
  Priorities [][]string
}

// RankablePair stores information about two choices relative to each other.
type RankablePair struct {
  A      string
  B      string
  FavorA int64
  FavorB int64
  Ties   int64
}

type RankedPairs []RankablePair

// Any "locked" pair that would create a cycle in the DAG must be ignored.
type CyclicalPair struct {
  RankedPair            RankablePair

  // OriginalRankDroppedAt refers to the index in the victoryMagnitude-sorted intermediate list of votes, not the index
  // in the final tsorted array returned from Result()
  OriginalRankDroppedAt int
}

// tally is an internal type that auto-creates RankablePairs as needed and exposes methods
// for incrementing counters given two choices' names in any order.
type tally map[string]map[string]*RankablePair

// Result returns a one-dimensional sorted slice of choices.
func (e *TidemanRankedPairsElection) Result() ([]string, []CyclicalPair) {
  tally := e.tally()
  pairs := tally.lockedPairs()
  return pairs.tsort()
}

// tally counts how many times voters preferred choice A > B, B > A, and B = A
func (e *TidemanRankedPairsElection) tally() tally {
  result := make(tally)

  for _, ballot := range e.Ballots {
    for _, ballotRankedPair := range ballot.runoffs() {
      if ballotRankedPair.Ties == 1 {
        result.incrementTies(ballotRankedPair.A, ballotRankedPair.B)
      } else {
        result.incrementWinner(ballotRankedPair.A, ballotRankedPair.B)
      }
    }
  }

  return result
}

// runoffs generates a slice of ranked pairs for an individual ballot that expresses the ballot's
// preferences if 1:1 runoff elections were ran for all choices against each other. This is one
// of the defining features of a voting method that satisfies the "Condorcet criterion".
func (ballot *Ballot) runoffs() []RankablePair {
  var result []RankablePair
  for indexOuter, choiceOuter := range ballot.Priorities {

    // First, add all ties to the slice we'll return at the end
    for tieOuterIndex := range choiceOuter {
      for tieInnerIndex := tieOuterIndex + 1; tieInnerIndex < len(choiceOuter); tieInnerIndex++ {
        result = append(result, RankablePair{
          A:      choiceOuter[tieOuterIndex],
          B:      choiceOuter[tieInnerIndex],
          FavorA: 0,
          FavorB: 0,
          Ties:   1,
        })
      }
    }

    // Second, add all non-ties across both dimensions (1st dimension = rank, 2nd dimension = file)
    for indexInner := indexOuter + 1; indexInner < len(ballot.Priorities); indexInner++ {
      for _, eachWinningChoiceOfSamePriority := range choiceOuter {
        for _, eachLosingChoiceOfSamePriority := range ballot.Priorities[indexInner] {
          // Ballot RankablePairs are always votes for A, or ties, but never a vote for B over A. They also include
          // combinations of A and B that would not be in the tally because the tally deterministically orders A and B
          // lexicographically such that A vs B and B vs A both share the same RankablePair in the tally.
          result = append(result, RankablePair{
            A:      eachWinningChoiceOfSamePriority,
            B:      eachLosingChoiceOfSamePriority,
            FavorA: 1,
          })
        }
      }
    }

  }
  return result
}

// victoryMagnitude describes how much a winner won over loser. A tie is counted as 1 vote for both choices.
func (pair *RankablePair) victoryMagnitude() int64 {
  var delta = pair.FavorA - pair.FavorB
  if delta < 0 {
    delta = -delta
  }
  return delta
}

// tsort uses a graph algorithm (a continuously topologically sorted Directed Acyclic Graph) to order the "locked"
// ranked pairs from a tally (which were sorted only by victoryMagnitude) such that all preferences are taken into
// consideration. If one of the victory-sorted locked ranked pairs would have created a cycle in the DAG, it is ignored
// and returned in the final return value separately for potential visualization purposes. The DAG that this uses is
// based on the gonum/graph library.
func (pairs *RankedPairs) tsort() ([]string, []CyclicalPair) {

  builder := newDAGBuilder()
  var cycles []CyclicalPair

  for i, pair := range *pairs {
    if pair.FavorA > pair.FavorB {
      if err := builder.addEdge(pair.A, pair.B); err != nil {
        cycles = append(cycles, CyclicalPair{RankedPair: pair, OriginalRankDroppedAt: i})
      }
    } else if pair.FavorB > pair.FavorA {
      if err := builder.addEdge(pair.B, pair.A); err != nil {
        cycles = append(cycles, CyclicalPair{RankedPair: pair, OriginalRankDroppedAt: i})
      }
    } else {
      // We got a tie. Try drawing directions between both

      // TODO: if either of these fail, neither edge should be added?
      abEdgeErr := builder.addEdge(pair.A, pair.B)
      baEdgeErr := builder.addEdge(pair.B, pair.A)

      if abEdgeErr != nil || baEdgeErr != nil {
        cycles = append(cycles, CyclicalPair{RankedPair: pair, OriginalRankDroppedAt: i})
      }
    }
  }

  return builder.tsort(), cycles
}

// lockedPairs orders all of the pairs in the tally by their victoryMagnitude, counting ties as 1 vote for
// both FavorA and FavorB.
func (t *tally) lockedPairs() RankedPairs {
  var result []RankablePair // copy structs into result because we mutate FavorA and FavorB
  for aKey := range *t {
    for bKey := range (*t)[aKey] {
      result = append(result, *(*t)[aKey][bKey])
    }
  }

  // For final counting purposes, we should add ties to both FavorA and FavorB
  for i, pair := range result {
    pair.FavorA += pair.Ties
    pair.FavorB += pair.Ties
    result[i] = pair
  }

  sort.SliceStable(result, func(i int, j int) bool {
    left, right := result[i], result[j]
    return left.victoryMagnitude() >= right.victoryMagnitude()
  })

  return result
}

// getPair handles auto-creation of the RankablePair if it didn't already exist and it
// guarantees that getPair(a,b) and getPair(b,a) would return the exact same pointer.
func (t *tally) getPair(first, second string) *RankablePair {
  a, b := orderStrings(first, second)

  if _, exists := (*t)[a]; !exists {
    (*t)[a] = map[string]*RankablePair{}
  }

  var pair = (*t)[a][b]
  if pair == nil {
    pair = &RankablePair{A: a, B: b}
    (*t)[a][b] = pair
  }

  return pair
}

// incrementWinner increments the count of winner's votes by 1 when given a winner and a loser,
func (t *tally) incrementWinner(winner, loser string) {
  pair := t.getPair(winner, loser)

  if pair.A == winner {
    pair.FavorA++
  } else if pair.B == winner {
    pair.FavorB++
  } else {
    panic(fmt.Errorf("invalid winner string given %s for pair with A=%s and B=%s", winner, pair.A, pair.B))
  }
}

// incrementTies increments the Ties in the pair for two choices given in either order.
func (t *tally) incrementTies(first, second string) {
  t.getPair(first, second).Ties++
}

// Deserializes a file that has the following format: "<voteid> <choiceA> <choiceB> <choiceC>". Ties can be expressed as
// "<choiceA>=<choiceB>". The returned value isn't as useful as the results of it which you can get by invoking Result()
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
      VoterID:    voterID,
      Priorities: prioritizedChoices,
    })
  }

  distinctChoicesSet := make(map[string]bool)
  for _, ballot := range ballots {
    for _, priorityChoices := range ballot.Priorities {
      for _, choice := range priorityChoices {
        distinctChoicesSet[choice] = true
      }
    }
  }
  var choices []string
  for key := range distinctChoicesSet {
    choices = append(choices, key)
  }
  sort.Strings(choices) // Remove non-determinism introduced by the map

  return TidemanRankedPairsElection{
    Ballots:        ballots,
    Choices:        choices,
    SourceFilename: filename,
  }
}

func orderStrings(first, second string) (string, string) {
  if first < second {
    return first, second
  }
  return second, first
}
