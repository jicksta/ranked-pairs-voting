package trp

import (
  . "github.com/onsi/ginkgo"
  . "github.com/onsi/ginkgo/extensions/table"
  . "github.com/onsi/gomega"
)

var _ = Describe("TidemanRankedPairsElection", func() {

  var e TidemanRankedPairsElection

  Describe("tally", func() {
    Describe("getPair", func() {
      It("guarantees a unique RankablePair for two candidates, irrespective of order passed in", func() {
        tally := make(tally)
        ba := tally.getPair("B", "A")
        ab := tally.getPair("A", "B")
        abAgain := tally.getPair("A", "B")

        Expect(ab).To(BeIdenticalTo(ba))
        Expect(ab).To(BeIdenticalTo(abAgain))
        Expect(ab.A).To(Equal("A"))
        Expect(ab.B).To(Equal("B"))
      })
    })

  })

  Describe("#runoffs()", func() {

    BeforeEach(func() {
      e = TidemanRankedPairsElection{
        Choices: []string{"A", "B", "C", "D"},
        Ballots: []Ballot{
          {
            VoterID: "ONE",
            Priorities: [][]string{
              {"A"},
              {"B", "C"},
              {"D"},
            },
          },
        },
        SourceFilename: "Doesn't Exist (Test)",
      }
    })

    It("computes OneVersusOneVotes according to Condorcet rules", func() {
      Expect(e.Ballots[0].runoffs()).To(Equal([]RankablePair{
        rankablePair("A", "B", false),
        rankablePair("A", "C", false),
        rankablePair("A", "D", false),
        rankablePair("B", "C", true),
        rankablePair("B", "D", false),
        rankablePair("C", "D", false),
      }))
    })

  })

  Describe("A simple contrived election with a single dictator", func() {

    Describe("#Tally1v1s()", func() {

      var tally tally

      BeforeEach(func() {
        tally = e.tally()
      })

      DescribeTable("tallies FavorA, FavorB, and Ties correctly",
        func(first, second string, favorFirst, favorSecond, ties int) {
          vote := tally.getPair(first, second)

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
      e = TidemanRankedPairsElection{
        Choices: []string{"A", "B", "C", "D"},
        Ballots: []Ballot{
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
        SourceFilename: "Doesn't Exist (Test)",
      }
    })
  })

  Describe("The Condorcet.ca workbench fixtures", func() {

    BeforeEach(func() {
      e = LoadElectionFile("../support/fixtures/condorcet.ca/scenario1.txt")
    })

    Context("scenario1", func() {

      It("has all the 5 expected choices", func() {
        Expect(e.Choices).To(ConsistOf([]string{
          "MOWZ_MIKE", "DUCH_DAWN", "SAMM_YOSEM_T", "YOTE_WALLY_C", "RUHNER_ROD",
        }))
      })

      It("has 22 votes", func() {
        Expect(e.Ballots).To(HaveLen(22))
      })

    })
  })

  // scenario5 is by far the most complex example
  Context("scenario5", func() {

    BeforeEach(func() {
      e = LoadElectionFile("../support/fixtures/condorcet.ca/scenario5.txt")
    })

    It("has 2000 votes", func() {
      Expect(e.Ballots).To(HaveLen(2000))
    })

    Describe("#lockedPairs", func() {

      var tally tally
      var sorted RankedPairs

      BeforeEach(func() {
        tally = e.tally()
        sorted = tally.lockedPairs()
      })

      It("has the expected winner by highest magnitude", func() {
        Expect(sorted[0]).To(Equal(RankablePair{
          A:      "FUDD_ELMIRA",
          B:      "RUHNER_ROD",
          FavorA: 1142,
          FavorB: 1064,
          Ties:   206,
        }))
      })

      It("calculates the expected winners", func() {
        result, dropped := sorted.tsort()
        var droppedPairs []RankablePair

        for _, drop := range dropped {
          droppedPairs = append(droppedPairs, drop.RankedPair)
        }
        Expect(result).To(Equal([]string{
          "FUDD_ELMIRA", "COYOTE_WALLY", "BYRD_TWEE_T", "MOWZ_MICHAEL", "SAM_YOSEMITE",
          "RUHNER_ROD", "DUCH_DAWN", "BUNNY_B", "MOWZ_MINERVA", "CAT_SYLVESTER_T",
        }))

        Expect(droppedPairs).To(Equal([]RankablePair{
          {A: "DUCH_DAWN", B: "MOWZ_MINERVA", FavorA: 1087, FavorB: 1102, Ties: 189},
          {A: "MOWZ_MINERVA", B: "RUHNER_ROD", FavorA: 1102, FavorB: 1099, Ties: 201},
          {A: "BUNNY_B", B: "MOWZ_MICHAEL", FavorA: 1095, FavorB: 1095, Ties: 190},
        }))

      })

    })

    Describe("#tally()", func() {

      var tally tally

      BeforeEach(func() {
        tally = e.tally()
      })

      DescribeTable("tallies FavorA, FavorB, and Ties correctly",
        func(first, second string, favorFirst, favorSecond, ties int) {
          vote := tally.getPair(first, second)

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

func rankablePair(winner, loser string, isTie bool) RankablePair {

  var favorA, ties int64

  if isTie {
    ties = 1
  } else {
    favorA = 1
  }

  return RankablePair{
    A:      winner,
    B:      loser,
    FavorA: favorA,
    FavorB: 0,
    Ties:   ties,
  }
}
