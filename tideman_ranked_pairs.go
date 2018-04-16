// Working implementation of the Tideman Ranked Pairs (TRP) Condorcet voting method
package trp

import (
	"bufio"
	"fmt"
	"github.com/olekukonko/tablewriter"
	"io"
	"regexp"
	"sort"
	"strings"
)

// Ballot represents an individual voter's preferences. Priorities are represented as a two-dimensional
// slice because there can be ties between choices at the same priority.
type Ballot struct {
	VoterID    string
	Priorities [][]string
}

// Election holds ballot data and a de-normalized sorted list of choices found in the ballots. To get the
// results of the election, call Results() on this object.
type Election struct {
	ElectionID string
	Ballots    []*Ballot
	Choices    []string
}

// ElectionResults has rich informational byproducts of the algorithm, as well as the final Winners sorted in
// descending order of priority.
type ElectionResults struct {

	// Election is a reference to the Election that generated these results
	Election *Election

	// Tally contains rich data about all combinations of Condorcet runoff elections as RankablePairs
	Tally *Tally

	// RankablePairs contains rich data about the sorting process performed with data from the Tally.
	RankedPairs *RankedPairs
}

// RankablePair stores information about two choices relative to each other.
type RankablePair struct {
	A      string
	B      string
	FavorA int64
	FavorB int64
	Ties   int64
}

// RankedPairs contains rich data about the final sorting process performed with data from the Tally. Note: The slice
// of Winners in this object will be the same as the Winners list in the ElectionResults struct.
type RankedPairs struct {
	// Winners contains the election choices sorted from greatest winners to worst losers. Ties are grouped in the second
	// dimension slice, sorted lexicographically.
	Winners [][]string

	// lockedPairs contains all RankablePairs from the Tally sorted by VictoryMagnitude. Note: The order of this may be
	// very different from Winners, and this will any RankablePairs that were ignored in the final sorting process because
	// they would have introduced a cycle in the Directed Acyclic Graph of winning pairs. See CyclicalLockedPairsIndices
	// for the indices in this slice of RankablePairs that cause cycles, if you care about such things.
	LockedPairs *[]RankablePair

	// CyclicalLockedPairsIndices holds the indices of members of lockedPairs that cause cycles
	CyclicalLockedPairsIndices []int
}

// Tally auto-creates RankablePairs as needed and exposes methods
// for incrementing counters given two choices' names in any order.
type Tally struct {
	pairs *map[string]map[string]*RankablePair
}

// TallyMatrix is helpful for visualizing the Tally.
type TallyMatrix struct {
	// Headings uses the same order (lexicographically sorted) for rows and columns.
	Headings []string

	// RowsColumns 1st dimension is the X axis, 2nd dimension is Y (i.e. individual cells). When X = Y, the pointer will be nil
	RowsColumns [][]*RankablePair

	// Tally stores a reference to the tally used to generate this Matrix
	Tally *Tally
}

// Results returns rich information about the final Election results.
func (e *Election) Results() *ElectionResults {
	tally := e.tally()
	rankedPairs := tally.RankedPairs()

	return &ElectionResults{
		Election:    e,
		Tally:       tally,
		RankedPairs: rankedPairs,
	}
}

// Winners is just a convenience method for accessing ElectionResults.RankedPairs.Winners
func (r *ElectionResults) Winners() [][]string {
	return r.RankedPairs.Winners
}

// Tally counts how many times voters preferred choice A > B, B > A, and B = A
func (e *Election) tally() *Tally {
	t := newTally()
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
func (ballot *Ballot) Runoffs() []*RankablePair {
	var result []*RankablePair
	for indexOuter, choiceOuter := range ballot.Priorities {

		// First, add all ties to the slice we'll return at the end
		for tieOuterIndex := range choiceOuter {
			for tieInnerIndex := tieOuterIndex + 1; tieInnerIndex < len(choiceOuter); tieInnerIndex++ {
				result = append(result, &RankablePair{
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
					result = append(result, &RankablePair{
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

// RankedPairs uses a graph algorithm (a continuously topologically sorted Directed Acyclic Graph) to order the "locked"
// ranked pairs from a Tally (which were sorted only by VictoryMagnitude) such that all preferences are taken into
// consideration. If one of the victory-sorted locked ranked pairs would have created a cycle in the DAG, it is ignored
// and returned in the final return value separately for potential visualization purposes. The DAG that this uses is
// based on the gonum/graph library.
func (t *Tally) RankedPairs() *RankedPairs {
	lockedPairs := t.lockedPairs()

	dagBuilder := newDAGBuilder()
	var cycles []int

	for i, pair := range *lockedPairs {
		if pair.FavorA > pair.FavorB {
			if err := dagBuilder.addEdge(pair.A, pair.B); err != nil {
				cycles = append(cycles, i)
			}
		} else if pair.FavorB > pair.FavorA {
			if err := dagBuilder.addEdge(pair.B, pair.A); err != nil {
				cycles = append(cycles, i)
			}
		} else {
			// We got a tie. Two nodes can't be bi-directed peers in a DAG because it would be considered a cycle.
			cycles = append(cycles, i)
		}
	}

	var sortedWinners = dagBuilder.tsort()
	var groupedWinners = make([][]string, 0, len(sortedWinners))
	for len(sortedWinners) > 0 {
		var lastIndexWithSameRank = 0
		for i := 1; i < len(sortedWinners); i++ {
			pair := t.GetPair(sortedWinners[0], sortedWinners[i])
			if pair.FavorA == pair.FavorB {
				lastIndexWithSameRank = i
			} else {
				break
			}
		}

		sameRankGroup := sortedWinners[:1+lastIndexWithSameRank]
		sort.Strings(sameRankGroup)
		groupedWinners = append(groupedWinners, sameRankGroup)

		sortedWinners = sortedWinners[1+lastIndexWithSameRank:]
	}

	return &RankedPairs{
		Winners:                    groupedWinners,
		LockedPairs:                lockedPairs,
		CyclicalLockedPairsIndices: cycles,
	}
}

func newTally() *Tally {
	pairs := make(map[string]map[string]*RankablePair)
	return &Tally{
		pairs: &pairs,
	}
}

// lockedPairs orders all of the pairs in the Tally by their VictoryMagnitude, counting ties as 1 vote for
// both FavorA and FavorB.
func (t *Tally) lockedPairs() *[]RankablePair {
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

	sort.SliceStable(result, func(i, j int) bool {
		left, right := result[i], result[j]
		return left.VictoryMagnitude() >= right.VictoryMagnitude()
	})

	return &result
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

func (t *Tally) knownChoices() []string {
	return sortedUniques(func(q chan<- string) {
		for outerKey := range *t.pairs {
			q <- outerKey
			for innerKey := range (*t.pairs)[outerKey] {
				q <- innerKey
			}
		}
	})
}

func (t *Tally) Matrix() *TallyMatrix {
	var headings = t.knownChoices()

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

func (t *Tally) PrintTable(writer io.Writer) {
	matrix := t.Matrix()
	table := tablewriter.NewWriter(writer)

	// Configure for Markdown table formatting
	table.SetBorders(tablewriter.Border{Left: true, Top: false, Right: true, Bottom: false})
	table.SetCenterSeparator("|")

	var headingsWithPrefixes = []string{"A"}
	for _, header := range matrix.Headings {
		headingsWithPrefixes = append(headingsWithPrefixes, "B="+header)
	}
	table.SetHeader(headingsWithPrefixes)

	for i, rowChoice := range matrix.Headings {
		rowPairs := matrix.RowsColumns[i]

		var cells = []string{"A=" + strings.ToUpper(rowChoice)}
		for j, pair := range rowPairs {
			if pair == nil {
				cells = append(cells, "")
				continue
			}
			columnChoice := matrix.Headings[j]
			var cellText string
			if columnChoice == pair.A {
				cellText = fmt.Sprintf("A=%d  B=%d  (%d)", pair.FavorA, pair.FavorB, pair.Ties)
			} else {
				cellText = fmt.Sprintf("A=%d  B=%d  (%d)", pair.FavorB, pair.FavorA, pair.Ties)
			}
			cells = append(cells, cellText)
		}

		table.Append(cells)
	}

	table.Render()
}

func (rp *RankedPairs) PrintTable(writer io.Writer) {
	table := tablewriter.NewWriter(writer)
	table.SetHeader([]string{"Rank", "A", "B", "# A", "# B", "# Ties", "Cyclical?", "Won by"})

	// Configure for Markdown table formatting
	table.SetBorders(tablewriter.Border{Left: true, Top: false, Right: true, Bottom: false})
	table.SetCenterSeparator("|")

	for i, pair := range *rp.LockedPairs {
		var isCyclical bool
		for _, cyclicalIndex := range rp.CyclicalLockedPairsIndices {
			if i == cyclicalIndex {
				isCyclical = true
				break
			}
		}
		table.Append([]string{
			fmt.Sprint(i + 1),
			pair.A,
			pair.B,
			fmt.Sprint(pair.FavorA),
			fmt.Sprint(pair.FavorB),
			fmt.Sprint(pair.Ties),
			fmt.Sprint(isCyclical),
			fmt.Sprint(pair.VictoryMagnitude()),
		})
	}

	table.Render()
}

// ReadElection deserializes a Election from a Reader using the following format:
//
//     <voterID> <choiceA> <choiceB> <choiceC>
//
// Ties can be expressed as <choiceA>=<choiceB>. For example:
//
//     VOTER_JAY  Finn=Jake  Bubblegum=Lemongrab  Marceline  IceKing
//
// In this example above, Finn and Jake are tied for 1st place, Bubblegum and Lemongrab
// are tied for 2nd, and Marceline and IceKing are 3rd and 4th places, respectively.
func ReadElection(electionID string, reader io.Reader) (*Election, error) {
	var ballots []*Ballot
	scanner := bufio.NewScanner(reader)
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
		ballots = append(ballots, &Ballot{
			VoterID:    voterID,
			Priorities: prioritizedChoices,
		})
	}

	return NewElection(electionID, ballots), nil
}

func NewElection(electionID string, ballots []*Ballot) *Election {
	choices := sortedUniques(func(q chan<- string) {
		for _, ballot := range ballots {
			for _, priorityChoices := range ballot.Priorities {
				for _, choice := range priorityChoices {
					q <- choice
				}
			}
		}
	})
	return &Election{
		ElectionID: electionID,
		Ballots:    ballots,
		Choices:    choices,
	}
}

// orderStrings returns two strings in lexicographical order when given two strings in any order.
func orderStrings(first, second string) (string, string) {
	if first < second {
		return first, second
	}
	return second, first
}

// sortedUniques invokes chanReceiver with a `chan string`. It returns a sorted slice of unique strings sent to the chan
func sortedUniques(chanReceiver func(chan<- string)) []string {
	Q := make(chan string)
	go func() {
		chanReceiver(Q)
		close(Q)
	}()

	set := make(map[string]bool)
	for str := range Q {
		set[str] = true
	}

	var strs []string
	for key := range set {
		strs = append(strs, key)
	}

	sort.Strings(strs)

	return strs
}
