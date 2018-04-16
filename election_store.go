package trp

type ElectionStore interface {
	GetElections() []string
	GetElection(string) (*Election, error)

	CreateElection(string, []*Ballot) (*Election, error)
	RemoveElection(string)

	SaveBallot(string, *Ballot) (*ElectionResults, error)
	RemoveBallot(string, string) (*ElectionResults, error)
}
