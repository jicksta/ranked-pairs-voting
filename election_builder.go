package trp

// ElectionBuilder exposes a simple builder-pattern DSL for building up an Election progressively.
type ElectionBuilder struct {
	ElectionID string
	Ballots    []*Ballot
}

func NewElectionBuilder(optionalElectionID ...string) *ElectionBuilder {
	var electionID string
	if len(optionalElectionID) == 1 {
		electionID = optionalElectionID[0]
	} else {
		electionID = "Election"
	}
	ballots := []*Ballot{}
	return &ElectionBuilder{electionID, ballots}
}

// Ballot creates a new Ballot given a two-dimensional slice of priorities
func (builder *ElectionBuilder) Ballot(voterID string, choices [][]string) *ElectionBuilder {
	ballot := &Ballot{
		VoterID:    voterID,
		Priorities: choices,
	}
	builder.Ballots = append(builder.Ballots, ballot)
	return builder
}

// Vote is similar to Ballot but it allows only a single dimension of choices (i.e. no ties)
func (builder *ElectionBuilder) Vote(voterID string, choices ...string) *ElectionBuilder {
	priorities := make([][]string, 0, len(choices))
	for _, rank := range choices {
		priorities = append(priorities, []string{rank})
	}
	return builder.Ballot(voterID, priorities)
}

// Election returns a new Election with all the ballots from this builder included
func (builder *ElectionBuilder) Election() *Election {
	return NewElection(builder.ElectionID, builder.Ballots)
}

// Results is simply a shorthand for Election().Results()
func (builder *ElectionBuilder) Results() *ElectionResults {
	return builder.Election().Results()
}
