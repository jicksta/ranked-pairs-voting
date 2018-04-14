package trp

import (
  "fmt"
  "strings"
  "regexp"
  "sort"
  "os"
  "bufio"
  "github.com/olekukonko/tablewriter"
  "io"
)

type CompletedElection struct {
  Ballots        []Ballot
  Choices        []string
  SourceFilename string
}

/*
type ContinuousElection interface {
  AddBallot(Ballot)
  RemoveVoter(string)
  Results() ([]string, []CyclicalPair)
}
type ElectionPersister interface {
  AddVote(Ballot)
  UpdateVote(Ballot)
  RemoveVote(string)
  SaveResults(ElectionResults)
}
*/

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

// CyclicalPair represents a ranked pair that was ignored in the final sorting because it would have introduced a cycle
// in the Directed Acyclic Graph of relative winners. These structs are supposed to be ignored and are only returned for
// possible visualization purposes or other similar uses.
type CyclicalPair struct {
  RankedPair RankablePair

  // OriginalRankDroppedAt refers to the index in the VictoryMagnitude-sorted intermediate list of votes, not the index
  // in the final tsorted array returned from Results(). This value is zero-indexed.
  OriginalRankDroppedAt int
}

// Tally auto-creates RankablePairs as needed and exposes methods
// for incrementing counters given two choices' names in any order.
type Tally struct {
  election *CompletedElection
  pairs    *map[string]map[string]*RankablePair
}

// Results returns a one-dimensional sorted slice of choices.
func (e *CompletedElection) Results() ([]string, []CyclicalPair) {
  tally := e.tally()

  tally.Matrix().Print(os.Stdout) /////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

  pairs := tally.LockedPairs()
  rankedChoices, cycles := pairs.Sort()
  return rankedChoices, cycles
}

// Tally counts how many times voters preferred choice A > B, B > A, and B = A
func (e *CompletedElection) tally() *Tally {
  t := newTally(e)
  for _, ballot := range e.Ballots {
    for _, ballotRankedPair := range ballot.Runoffs() {
      if ballotRankedPair.Ties == 1 {
        t.incrementTies(ballotRankedPair.A, ballotRankedPair.B)
      } else {
        t.incrementWinner(ballotRankedPair.A, ballotRankedPair.B)
      }
    }
  }

  return t
}

// Runoffs generates a slice of ranked pairs for an individual ballot that expresses the ballot's
// preferences if 1:1 runoff elections were ran for all choices against each other. This is one
// of the defining features of a voting method that satisfies the "Condorcet criterion".
func (ballot *Ballot) Runoffs() []RankablePair {
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
          // combinations of A and B that would not be in the Tally because the Tally deterministically orders A and B
          // lexicographically such that A vs B and B vs A both share the same RankablePair in the Tally.
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

// VictoryMagnitude describes how much a winner won over loser. A tie is counted as 1 vote for both choices.
func (pair *RankablePair) VictoryMagnitude() int64 {
  var delta = pair.FavorA - pair.FavorB
  if delta < 0 {
    delta = -delta
  }
  return delta
}

// Sort uses a graph algorithm (a continuously topologically sorted Directed Acyclic Graph) to order the "locked"
// ranked pairs from a Tally (which were sorted only by VictoryMagnitude) such that all preferences are taken into
// consideration. If one of the victory-sorted locked ranked pairs would have created a cycle in the DAG, it is ignored
// and returned in the final return value separately for potential visualization purposes. The DAG that this uses is
// based on the gonum/graph library.
func (pairs RankedPairs) Sort() ([]string, []CyclicalPair) {
  builder := newDAGBuilder()
  var cycles []CyclicalPair

  for i, pair := range pairs {
    if pair.FavorA > pair.FavorB {
      if err := builder.addEdge(pair.A, pair.B); err != nil {
        cycles = append(cycles, CyclicalPair{RankedPair: pair, OriginalRankDroppedAt: i})
      }
    } else if pair.FavorB > pair.FavorA {
      if err := builder.addEdge(pair.B, pair.A); err != nil {
        cycles = append(cycles, CyclicalPair{RankedPair: pair, OriginalRankDroppedAt: i})
      }
    } else {
      // We got a tie. Two nodes can't be bi-directed peers in a DAG because it would be considered a cycle.
      cycles = append(cycles, CyclicalPair{RankedPair: pair, OriginalRankDroppedAt: i})
    }
  }

  return builder.tsort(), cycles
}


// Tally counts how many times voters preferred choice A > B, B > A, and B = A
func newTally(e *CompletedElection) *Tally {
  pairs := make(map[string]map[string]*RankablePair)
  return &Tally{
    election: e,
    pairs:    &pairs,
  }
}

// LockedPairs orders all of the pairs in the Tally by their VictoryMagnitude, counting ties as 1 vote for
// both FavorA and FavorB.
func (t *Tally) LockedPairs() *RankedPairs {
  var result []RankablePair // copy structs into result because we mutate FavorA and FavorB
  for aKey := range *t.pairs {
    for bKey := range (*t.pairs)[aKey] {
      result = append(result, *(*t.pairs)[aKey][bKey])
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
    return left.VictoryMagnitude() >= right.VictoryMagnitude()
  })

  rankedPairs := RankedPairs(result)
  return &rankedPairs
}

// GetPair handles auto-creation of the RankablePair if it didn't already exist and it
// guarantees that GetPair(a,b) and GetPair(b,a) would return the exact same pointer.
func (t *Tally) GetPair(first, second string) *RankablePair {
  a, b := orderStrings(first, second)

  if _, exists := (*t.pairs)[a]; !exists {
    (*t.pairs)[a] = map[string]*RankablePair{}
  }

  var pair = (*t.pairs)[a][b]
  if pair == nil {
    pair = &RankablePair{A: a, B: b}
    (*t.pairs)[a][b] = pair
  }

  return pair
}

// incrementWinner increments the count of winner's votes by 1 when given a winner and a loser,
func (t *Tally) incrementWinner(winner, loser string) {
  pair := t.GetPair(winner, loser)

  if pair.A == winner {
    pair.FavorA++
  } else if pair.B == winner {
    pair.FavorB++
  } else {
    panic(fmt.Errorf("invalid winner string given %s for pair with A=%s and B=%s", winner, pair.A, pair.B))
  }
}

// incrementTies increments the Ties in the pair for two choices given in either order.
func (t *Tally) incrementTies(first, second string) {
  t.GetPair(first, second).Ties++
}

type TallyMatrix struct {
  // Headings uses the same order (lexicographically sorted) for rows and columns.
  Headings []string

  // RowsColumns 1st dimension is the X axis, 2nd dimension is Y (i.e. individual cells). When X = Y, the pointer will be nil
  RowsColumns [][]*RankablePair

  // Tally stores a reference to the tally used to generate this Matrix
  Tally *Tally
}

func (t *Tally) Matrix() *TallyMatrix {
  var headings = t.election.Choices
  var rowsColumns [][]*RankablePair

  for _, yChoice := range headings {
    var row []*RankablePair
    for _, xChoice := range headings {
      if yChoice == xChoice {
        row = append(row, nil)
      } else {
        row = append(row, t.GetPair(yChoice, xChoice))
      }
    }
    rowsColumns = append(rowsColumns, row)
  }
  return &TallyMatrix{Headings: headings, RowsColumns: rowsColumns}
}

func (t *TallyMatrix) Print(writer io.Writer) {
  table := tablewriter.NewWriter(writer)

  var headingsWithPrefixes = []string {"A"}
  for _, header := range t.Headings {
    headingsWithPrefixes = append(headingsWithPrefixes, "B=" + header)
  }
  table.SetHeader(headingsWithPrefixes)

  for i, rowChoice := range t.Headings {
    rowPairs := t.RowsColumns[i]

    var cells = []string {"A=" + rowChoice}
    for j, pair := range rowPairs {
      if pair == nil {
        cells = append(cells, "")
        continue
      }
      columnChoice :=  t.Headings[j]
      var cellText string
      if columnChoice == pair.A {
        cellText = fmt.Sprintf("A=%d B=%d (%d)", pair.FavorA, pair.FavorB, pair.Ties)
      } else {
        cellText = fmt.Sprintf("A=%d B=%d (%d)", pair.FavorB, pair.FavorA, pair.Ties)
      }
      cells = append(cells, cellText)
    }

    table.Append(cells)
  }

  //winners, _ := t.Tally.Election.Results()
  //table.SetFooter(append([]string{"WINNERS"}, winners...))
  //table.SetFooter(winners)

  table.Render()
}

// Deserializes a file that has the following format: `<voteid> <choiceA> <choiceB> <choiceC>`. Ties can be expressed as
// `<choiceA>=<choiceB>`. The returned struct isn't as useful as the results of it which you can get by invoking `Results()`
func LoadElectionFile(filename string) CompletedElection {
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

  return CompletedElection{
    Ballots:        ballots,
    Choices:        choices,
    SourceFilename: filename,
  }
}

//func (e *CompletedElection) GraphViz() {
//  e.tally().LockedPairs().Sort() // TODO
//}

func orderStrings(first, second string) (string, string) {
  if first < second {
    return first, second
  }
  return second, first
}
