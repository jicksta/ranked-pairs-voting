package trp

import (
  . "github.com/onsi/ginkgo"
  . "github.com/onsi/ginkgo/extensions/table"
  . "github.com/onsi/gomega"
  "os"
)

var _ = Describe("Election", func() {

  var e *Election

  Describe("Runoffs()", func() {

    BeforeEach(func() {
      e = &Election{
        Choices: []string{"A", "B", "C", "D"},
        Ballots: []*Ballot{
          {
            VoterID: "ONE",
            Priorities: [][]string{
              {"A"},
              {"B", "C"},
              {"D"},
            },
          },
        },
      }
    })

    It("computes OneVersusOneVotes according to Condorcet rules", func() {
      Expect(e.Ballots[0].Runoffs()).To(Equal([]*RankablePair{
        rankablePair("A", "B", false),
        rankablePair("A", "C", false),
        rankablePair("A", "D", false),
        rankablePair("B", "C", true),
        rankablePair("B", "D", false),
        rankablePair("C", "D", false),
      }))
    })

  })

  Describe("tested against a fixture", func() {

    Describe("of a contrived election with a single dictator", func() {

      Describe("#Tally1v1s()", func() {

        var tally *Tally

        BeforeEach(func() {
          tally = e.tally()
        })

        DescribeTable("tallies FavorA, FavorB, and Ties correctly",
          func(first, second string, favorFirst, favorSecond, ties int) {
            vote := tally.GetPair(first, second)

            if first == vote.B {
              favorFirst, favorSecond = favorSecond, favorFirst
            }

            Expect(vote.FavorA).To(Equal(int64(favorFirst)))
            Expect(vote.FavorB).To(Equal(int64(favorSecond)))
            Expect(vote.Ties).To(Equal(int64(ties)))
          },
          Entry("A vs B", "A", "B", 2, 1, 0),
          Entry("A vs C", "A", "B", 2, 1, 0),
          Entry("A vs D", "A", "B", 2, 1, 0),
          Entry("B vs C", "B", "C", 1, 1, 1),
          Entry("B vs D", "B", "D", 3, 0, 0),
          Entry("C vs D", "C", "D", 3, 0, 0),
        )

      })

      BeforeEach(func() {
        e = &Election{
          Choices: []string{"A", "B", "C", "D"},
          Ballots: []*Ballot{
            {
              VoterID: "ONE",
              Priorities: [][]string{
                {"A"},
                {"B", "C"},
                {"D"},
              },
            },
            {
              VoterID: "TWO",
              Priorities: [][]string{
                {"A"},
                {"B"},
                {"C"},
                {"D"},
              },
            },
            {
              VoterID: "THREE",
              Priorities: [][]string{
                {"C"},
                {"B"},
                {"D"},
                {"A"},
              },
            },
          },
        }
      })
    })

    Describe("from the Condorcet.ca workbench", func() {

      Context("scenario1", func() {

        BeforeEach(func() {
          e = loadElectionFile("fixtures/condorcet.ca/scenario1.txt")
        })

        It("has all the 5 expected choices", func() {
          Expect(e.Choices).To(ConsistOf([]string{
            "MOWZ_MIKE", "DUCH_DAWN", "SAMM_YOSEM_T", "YOTE_WALLY_C", "RUHNER_ROD",
          }))
        })

        It("has 22 votes", func() {
          Expect(e.Ballots).To(HaveLen(22))
        })

      })


      // scenario5 is by far the most complex example
      Context("scenario5.txt", func() {

        BeforeEach(func() {
          e = loadElectionFile("fixtures/condorcet.ca/scenario5.txt")
        })

        It("has 2000 votes", func() {
          Expect(e.Ballots).To(HaveLen(2000))
        })

        Describe("#RankedPairs", func() {

          var tally *Tally
          var ranked *RankedPairs

          BeforeEach(func() {
            tally = e.tally()
            ranked = tally.RankedPairs()
          })

          It("has the expected highest LockedPair by highest magnitude", func() {
            Expect((*ranked.LockedPairs)[0]).To(Equal(RankablePair{
              A:      "FUDD_ELMIRA",
              B:      "RUHNER_ROD",
              FavorA: 1142,
              FavorB: 1064,
              Ties:   206,
            }))
          })

          It("calculates the expected winners", func() {
            var droppedPairs []RankablePair

            for _, cyclicalIndex := range ranked.CyclicalLockedPairsIndices {
              droppedPairs = append(droppedPairs, (*ranked.LockedPairs)[cyclicalIndex])
            }

            Expect(ranked.Winners).To(Equal([][]string{
              {"FUDD_ELMIRA"}, {"COYOTE_WALLY"}, {"BYRD_TWEE_T"}, {"MOWZ_MICHAEL"}, {"SAM_YOSEMITE"},
              {"RUHNER_ROD"}, {"DUCH_DAWN"}, {"BUNNY_B"}, {"MOWZ_MINERVA"}, {"CAT_SYLVESTER_T"},
            }))

            Expect(droppedPairs).To(Equal([]RankablePair{
              {A: "DUCH_DAWN", B: "MOWZ_MINERVA", FavorA: 1087, FavorB: 1102, Ties: 189},
              {A: "MOWZ_MINERVA", B: "RUHNER_ROD", FavorA: 1102, FavorB: 1099, Ties: 201},
              {A: "BUNNY_B", B: "MOWZ_MICHAEL", FavorA: 1095, FavorB: 1095, Ties: 190},
            }))

          })

        })

        Describe("#Tally()", func() {

          var tally *Tally

          BeforeEach(func() {
            tally = e.tally()
          })

          DescribeTable("tallies FavorA, FavorB, and Ties correctly",
            func(first, second string, favorFirst, favorSecond, ties int) {
              vote := tally.GetPair(first, second)

              if first == vote.B {
                favorFirst, favorSecond = favorSecond, favorFirst
              }

              Expect(vote.FavorA).To(Equal(int64(favorFirst)))
              Expect(vote.FavorB).To(Equal(int64(favorSecond)))
              Expect(vote.Ties).To(Equal(int64(ties)))
            },
            Entry("MOWZ_MICHAEL vs DUCH_DAWN", "MOWZ_MICHAEL", "DUCH_DAWN", 922, 896, 182),
            Entry("MOWZ_MICHAEL vs BUNNY_B", "MOWZ_MICHAEL", "BUNNY_B",     905, 905, 190),
            Entry("MOWZ_MINERVA vs DUCH_DAWN", "MOWZ_MINERVA", "DUCH_DAWN", 913, 898, 189),
          )

        })

      })

    })

  })

  Describe("sortedUniques()", func() {
    It("returns the sorted unique strings sent to the chan", func() {
      actual := sortedUniques(func(q chan<- string) {
        q <- "Jay"
        q <- "Phillips"
        q <- "Jay"
        q <- "foo"
        q <- "bar"
      })
      Expect(actual).To(Equal([]string {"Jay", "Phillips", "bar", "foo"})) // go string sorting collates according to ASCII char values (capitals earlier)
    })
  })

  Describe("Results()", func() {
    It("groups ties", func() {
      e = NewElection("e", []*Ballot{
        {VoterID:"ONE",   Priorities:[][]string{{"A"}, {"B"}, {"C"}}},
        {VoterID:"TWO",   Priorities:[][]string{{"B"}, {"A"}, {"C"}}},
        {VoterID:"THREE", Priorities:[][]string{{"C"}, {"A", "B"}}},
      })

      Expect(e.Results().Winners()).To(Equal([][]string{{"A", "B"}, {"C"}}))
    })
  })

})

var _ = Describe("Tally", func() {
  Describe("#GetPair", func() {
    It("guarantees a unique RankablePair for two candidates, irrespective of order passed in", func() {
      tally := newTally()
      ba := tally.GetPair("B", "A")
      ab := tally.GetPair("A", "B")
      abAgain := tally.GetPair("A", "B")

      Expect(ab).To(BeIdenticalTo(ba))
      Expect(ab).To(BeIdenticalTo(abAgain))
      Expect(ab.A).To(Equal("A"))
      Expect(ab.B).To(Equal("B"))
    })
  })
})

func rankablePair(winner, loser string, isTie bool) *RankablePair {
  var favorA, ties int64
  if isTie {
    ties = 1
  } else {
    favorA = 1
  }
  return &RankablePair{
    A:      winner,
    B:      loser,
    FavorA: favorA,
    FavorB: 0,
    Ties:   ties,
  }
}

func loadElectionFile(filename string) *Election {
  f, _ := os.Open(filename)
  defer f.Close()
  election, _ := ReadElection(filename, f)
  return election
}