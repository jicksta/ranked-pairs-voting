package trp

import (
  . "github.com/onsi/ginkgo"
  . "github.com/onsi/gomega"
)

var _ = Describe("MemoryStore", func() {

  var store *MemoryStore
  var noBallots []*Ballot

  BeforeEach(func() {
    store = NewMemoryStore()
    noBallots = []*Ballot{}
  })

  It("implements the ElectionStore interface", func() {
    var _ = ElectionStore(store)
  })

  Describe("#GetElections", func() {
    It("returns election IDs of elections that have been created", func() {
      store.CreateElection("foo", noBallots)
      store.CreateElection("bar", noBallots)
      Expect(store.GetElections()).To(ConsistOf([]string{"foo", "bar"}))
    })
  })

  Describe("#GetElection", func() {
    It("returns an error when an election hasn't been created", func() {
      result, err := store.GetElection("doesn't exist")
      Expect(result).To(BeNil())
      Expect(err).NotTo(Succeed())
    })

    It("returns an election if it has been previously created", func() {
      id := "created"
      election, _ := store.CreateElection(id, noBallots)
      Expect(election).ToNot(BeNil())
      get, err := store.GetElection(id)
      Expect(err).To(Succeed())
      Expect(get).To(Equal(election))
    })
  })

  Describe("#CreateElection", func() {
    It("creates an election that can be retrieved", func() {
      id := "created"

      created, err := store.CreateElection(id, noBallots)
      Expect(err).To(Succeed())

      get, err := store.GetElection(id)
      Expect(get).To(Equal(created))
      Expect(err).To(Succeed())
    })
  })

  Describe("#RemoveElection", func() {
    It("deletes an election in the memory store", func() {
      store.CreateElection("foo", noBallots)
      store.CreateElection("bar", noBallots)
      Expect(store.GetElections()).To(ConsistOf([]string{"foo", "bar"}))
      store.RemoveElection("bar")
      Expect(store.GetElections()).To(ConsistOf([]string{"foo"}))
      get, err := store.GetElection("bar")
      Expect(get).To(BeNil())
      Expect(err).NotTo(Succeed())
    })

  })

  Describe("#SaveBallot", func() {
    It("returns an error the election hasn't been created", func() {
      ballot := ballot("voter", [][]string{{"A"}, {"B"}})
      result, err := store.SaveBallot("doesn't exist", ballot)
      Expect(result).To(BeNil())
      Expect(err).NotTo(Succeed())
    })

    It("returns re-computed results when adding new ballots", func() {
      electionID := "election"
      var results *ElectionResults

      store.CreateElection(electionID, noBallots)

      results, _ = store.SaveBallot(electionID, ballot("voter1", [][]string{{"A"}, {"B"}, {"C"}}))
      Expect(results.Winners()[0]).To(Equal([]string{"A"}))

      results, _ = store.SaveBallot(electionID, ballot("voter2", [][]string{{"B"}, {"A"}, {"C"}}))
      Expect(results.Winners()[0]).To(Equal([]string{"A", "B"}))
    })

  })

  Describe("#RemoveBallot", func() {
    It("removes the ballot for a voter from the store and returns re-computed results", func() {
      electionID := "remove ballot test"
      voter1, voter2 := "voter_1", "voter_2"

      store.CreateElection(electionID, noBallots)

      removedBallot := ballot(voter1, [][]string{{"B"}, {"C"}, {"A"}})
      store.SaveBallot(electionID, removedBallot)
      store.SaveBallot(electionID, ballot(voter2, [][]string{{"A"}, {"B"}, {"C"}}))

      election := func() *Election {
        e, err := store.GetElection(electionID)
        Expect(err).To(Succeed())
        return e
      }

      Expect(election().Ballots).To(ContainElement(removedBallot))

      Expect(election().Results().Winners()[0]).To(Equal([]string{"B"}))
      store.RemoveBallot(electionID, removedBallot.VoterID)

      Expect(election().Results().Winners()[0]).To(Equal([]string{"A"}))
      Expect(election().Ballots).NotTo(ContainElement(removedBallot))
    })
  })

})

func ballot(id string, priorities [][]string) *Ballot {
  return &Ballot{VoterID: id, Priorities: priorities}
}