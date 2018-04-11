package trp

import (
	. "github.com/onsi/ginkgo"
	. "github.com/onsi/ginkgo/extensions/table"
	. "github.com/onsi/gomega"
)

var _ = Describe("TidemanRankedPairsElection", func() {

	var e TidemanRankedPairsElection

	Describe("tally", func() {
		Describe("lookup", func() {
			It("guarantees a unique OneVersusOneVote for two candidates, irrespective of order passed in", func() {
				tally := make(tally)
				ba := tally.lookup("B", "A")
				ab := tally.lookup("A", "B")
				abAgain := tally.lookup("A", "B")

				Expect(ab).To(BeIdenticalTo(ba))
				Expect(ab).To(BeIdenticalTo(abAgain))
				Expect(ab.A).To(Equal("A"))
				Expect(ab.B).To(Equal("B"))
			})
		})

	})

	Describe("#equivalentRoundRobinVotes()", func() {

		BeforeEach(func() {
			e = TidemanRankedPairsElection{
				Candidates: []string{"A", "B", "C", "D"},
				Ballots: []Ballot{
					Ballot{
						VoterID: "ONE",
						Choices: [][]string{
							[]string{"A"},
							[]string{"B", "C"},
							[]string{"D"},
						},
					},
				},
				SourceFilename: "Doesn't Exist (Test)",
			}
		})

		It("computes OneVersusOneVotes according to Condorcet rules", func() {
			Expect(e.Ballots[0].equivalentRoundRobinVotes()).To(Equal([]OneVersusOneVote{
				vote1v1("A", "B", false),
				vote1v1("A", "C", false),
				vote1v1("A", "D", false),
				vote1v1("B", "C", true),
				vote1v1("B", "D", false),
				vote1v1("C", "D", false),
			}))
		})

	})

	Describe("A simple contrived election with a single dictator", func() {

		Describe("#Tally1v1s()", func() {

			var tally tally

			BeforeEach(func() {
				tally = e.tally1v1s()
			})

			DescribeTable("tallies FavorA, FavorB, and Ties correctly",
				func(first, second string, favorFirst, favorSecond, ties int) {
					vote := tally.lookup(first, second)

					if first == vote.B {
						favorFirst, favorSecond = favorSecond, favorFirst
					}

					Expect(vote.FavorA).To(Equal(favorFirst))
					Expect(vote.FavorB).To(Equal(favorSecond))
					Expect(vote.Ties).To(Equal(ties))
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
				Candidates: []string{"A", "B", "C", "D"},
				Ballots: []Ballot{
					Ballot{
						VoterID: "ONE",
						Choices: [][]string{
							[]string{"A"},
							[]string{"B", "C"},
							[]string{"D"},
						},
					},
					Ballot{
						VoterID: "TWO",
						Choices: [][]string{
							[]string{"A"},
							[]string{"B"},
							[]string{"C"},
							[]string{"D"},
						},
					},
					Ballot{
						VoterID: "THREE",
						Choices: [][]string{
							[]string{"C"},
							[]string{"B"},
							[]string{"D"},
							[]string{"A"},
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
				Expect(e.Candidates).To(ConsistOf([]string{
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

		Describe("#sortedByMagnitudeVictory", func() {

			var tally tally
			var sorted VotesList

			BeforeEach(func() {
				tally = e.tally1v1s()
				sorted = tally.sortedByMagnitudeVictory()
			})

			It("has the expected winner by highest magnitude", func() {
				Expect(sorted[0]).To(Equal(OneVersusOneVote{
					A:      "FUDD_ELMIRA",
					B:      "RUHNER_ROD",
					FavorA: 1142,
					FavorB: 1064,
					Ties:   206,
				}))
			})

			It("calculates the expected winners", func() {
				result, dropped := sorted.tsort()
				Expect(result).To(Equal([]string{
					"FUDD_ELMIRA", "COYOTE_WALLY", "BYRD_TWEE_T", "MOWZ_MICHAEL", "SAM_YOSEMITE",
					"RUHNER_ROD", "DUCH_DAWN", "BUNNY_B", "MOWZ_MINERVA", "CAT_SYLVESTER_T",
				}))

				var droppedVotes []OneVersusOneVote
				for _, drop := range dropped {
					droppedVotes = append(droppedVotes, drop.Vote)
				}
				Expect(droppedVotes).To(Equal([]OneVersusOneVote{
					OneVersusOneVote{A: "DUCH_DAWN", B: "MOWZ_MINERVA", FavorA: 1087, FavorB: 1102, Ties: 189},
					OneVersusOneVote{A: "MOWZ_MINERVA", B: "RUHNER_ROD", FavorA: 1102, FavorB: 1099, Ties: 201},
					OneVersusOneVote{A: "BUNNY_B", B: "MOWZ_MICHAEL", FavorA: 1095, FavorB: 1095, Ties: 190},
				}))

			})

		})

		Describe("#Tally1v1s()", func() {

			var tally tally

			BeforeEach(func() {
				tally = e.tally1v1s()
			})

			DescribeTable("tallies FavorA, FavorB, and Ties correctly",
				func(first, second string, favorFirst, favorSecond, ties int) {
					vote := tally.lookup(first, second)

					if first == vote.B {
						favorFirst, favorSecond = favorSecond, favorFirst
					}

					Expect(vote.FavorA).To(Equal(favorFirst))
					Expect(vote.FavorB).To(Equal(favorSecond))
					Expect(vote.Ties).To(Equal(ties))
				},
				Entry("MOWZ_MICHAEL vs DUCH_DAWN", "MOWZ_MICHAEL", "DUCH_DAWN", 922, 896, 182),
				Entry("MOWZ_MICHAEL vs BUNNY_B", "MOWZ_MICHAEL", "BUNNY_B", 905, 905, 190),
				Entry("MOWZ_MINERVA vs DUCH_DAWN", "MOWZ_MINERVA", "DUCH_DAWN", 913, 898, 189),
			)

		})

	})

})

func vote1v1(winner, loser string, isTie bool) OneVersusOneVote {

	var favorA, ties int

	if isTie {
		ties = 1
	} else {
		favorA = 1
	}

	return OneVersusOneVote{
		A:      winner,
		B:      loser,
		FavorA: favorA,
		FavorB: 0,
		Ties:   ties,
	}
}
