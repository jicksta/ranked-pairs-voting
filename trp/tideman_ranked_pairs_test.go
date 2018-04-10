package trp_test

import (
	. "github.com/onsi/ginkgo"
	. "github.com/onsi/ginkgo/extensions/table"
	. "github.com/onsi/gomega"

	trp "github.com/jicksta/go-ranked-pair-voting/trp"
)

var _ = Describe("TidemanRankedPairsElection", func() {

	var e trp.TidemanRankedPairsElection

	Describe("Tally", func() {
		Describe("Lookup", func() {
			It("guarantees a unique OneVersusOneVote for two candidates, irrespective of order passed in", func() {
				tally := make(trp.Tally)
				ba, _, _ := tally.Lookup("B", "A")
				ab, _, _ := tally.Lookup("A", "B")
				abAgain, _, _ := tally.Lookup("A", "B")

				Expect(ab).To(BeIdenticalTo(ba))
				Expect(ab).To(BeIdenticalTo(abAgain))
				Expect(ab.A).To(Equal("A"))
				Expect(ab.B).To(Equal("B"))
			})
		})

	})

	Describe("#EquivalentRoundRobinVotes()", func() {

		BeforeEach(func() {
			e = trp.TidemanRankedPairsElection{
				Candidates: []string{"A", "B", "C", "D"},
				Votes: []trp.Vote{
					trp.Vote{
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
			Expect(e.Votes[0].EquivalentRoundRobinVotes()).To(Equal([]trp.OneVersusOneVote{
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

			var tally trp.Tally

			JustBeforeEach(func() {
				tally = e.Tally1v1s()
			})

			DescribeTable("tallies FavorA, FavorB, and Ties correctly",
				func(first, second string, favorFirst, favorSecond, ties int) {
					vote, _, b := tally.Lookup(first, second)

					if first == b {
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
			e = trp.TidemanRankedPairsElection{
				Candidates: []string{"A", "B", "C", "D"},
				Votes: []trp.Vote{
					trp.Vote{
						VoterID: "ONE",
						Choices: [][]string{
							[]string{"A"},
							[]string{"B", "C"},
							[]string{"D"},
						},
					},
					trp.Vote{
						VoterID: "TWO",
						Choices: [][]string{
							[]string{"A"},
							[]string{"B"},
							[]string{"C"},
							[]string{"D"},
						},
					},
					trp.Vote{
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
			e = trp.DeserializeFile("../support/fixtures/condorcet.ca/scenario1.txt")
		})

		Context("scenario1", func() {

			It("has all the 5 expected choices", func() {
				Expect(e.Candidates).To(ConsistOf([]string{
					"MOWZ_MIKE", "DUCH_DAWN", "SAMM_YOSEM_T", "YOTE_WALLY_C", "RUHNER_ROD",
				}))
			})

			It("has 22 votes", func() {
				Expect(e.Votes).To(HaveLen(22))
			})

			XIt("determines winners consistent with the workbench reference application", func() {
				// winners := e.Ranks()
				// Expect(winners).To(HaveLen(4))
				// Expect(winners[0].winner).To(Equal([]string{"MOWZ_MIKE"}))
				// Expect(winners[1].winner).To(Equal([]string{"DUCH_DAWN", "SAMM_YOSEM_T"}))
				// Expect(winners[2].winner).To(Equal([]string{"YOTE_WALLY_C"}))
				// Expect(winners[3].winner).To(Equal([]string{"RUHNER_ROD"}))
			})
		})
	})

	Context("scenario5", func() {

		BeforeEach(func() {
			e = trp.DeserializeFile("../support/fixtures/condorcet.ca/scenario5.txt")
		})

		It("has 2000 votes", func() {
			Expect(e.Votes).To(HaveLen(2000))
		})

		Describe("#Tally1v1s()", func() {

			var tally trp.Tally

			BeforeEach(func() {
				tally = e.Tally1v1s()
			})

			DescribeTable("tallies FavorA, FavorB, and Ties correctly",
				func(first, second string, favorFirst, favorSecond, ties int) {
					vote, _, b := tally.Lookup(first, second)

					if first == b {
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

func vote1v1(winner, loser string, isTie bool) trp.OneVersusOneVote {

	var favorA, ties int

	if isTie {
		ties = 1
	} else {
		favorA = 1
	}

	return trp.OneVersusOneVote{
		A:      winner,
		B:      loser,
		FavorA: favorA,
		FavorB: 0,
		Ties:   ties,
	}
}
