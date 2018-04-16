package trp

import "fmt"

type MemoryStore map[string]*Election

func NewMemoryStore() *MemoryStore {
  store := make(MemoryStore)
  return &store
}

func (ms *MemoryStore) GetElections() []string {
  var result []string
  for electionID := range *ms {
    result = append(result, electionID)
  }
  return result
}

func (ms *MemoryStore) GetElection(electionID string) (*Election, error) {
  var election, found = (*ms)[electionID]
  if !found {
    return nil, fmt.Errorf("no election with id %s", electionID)
  }
  return election, nil
}

func (ms *MemoryStore) CreateElection(electionID string, ballots []*Ballot) (*Election, error) {
  election := NewElection(electionID, ballots)
  (*ms)[electionID] = election
  return election, nil
}

func (ms *MemoryStore) RemoveElection(electionID string) {
  delete(*ms, electionID)
}

func (ms *MemoryStore) SaveBallot(electionID string, newBallot *Ballot) (*ElectionResults, error) {
  election, err := ms.GetElection(electionID)
  if err != nil {
    return nil, err
  }

  var newBallots = []*Ballot{newBallot}
  for _, b := range election.Ballots {
    if b.VoterID != newBallot.VoterID {
      newBallots = append(newBallots, b)
    }
  }
  newElection := NewElection(electionID, newBallots)
  (*ms)[electionID] = newElection
  results := newElection.Results()
  return results, nil
}

func (ms *MemoryStore) RemoveBallot(electionID string, removedVoterID string) (*ElectionResults, error) {
  prevElection, _ := ms.GetElection(electionID)

  var ballots []*Ballot
  for _, b := range prevElection.Ballots {
    if b.VoterID != removedVoterID {
      ballots = append(ballots, b)
    }
  }

  newElection := NewElection(electionID, ballots)
  (*ms)[electionID] = newElection

  return newElection.Results(), nil
}
