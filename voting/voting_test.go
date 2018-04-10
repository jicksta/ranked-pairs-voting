package voting

import (
	. "github.com/onsi/ginkgo"
	. "github.com/onsi/ginkgo/extensions/table"
	. "github.com/onsi/gomega"
)

var _ = Describe("The Tideman Ranked Pair election calculator", func() {

	var e Election

	Context("An Election instance loaded from the Tennessee fixture", func() {

		BeforeEach(func() {
			e = LoadElectionFromFile("../support/fixtures/wikipedia_tennessee.txt")
		})

		It("has 4 Candidates", func() {
			Expect(len(e.Candidates)).To(Equal(4))
		})

		DescribeTable("has the expected tallies of Condorcet comparisons",
			func(city1 string, city2 string, count1 int, count2 int) {
				counts := e.CondorcetComparisonCounts()
				Expect(counts[newPair(city1, city2)]).To(Equal(count1))
				Expect(counts[newPair(city2, city1)]).To(Equal(count2))
			},
			Entry("Memphis vs Nashville", "Memphis", "Nashville", 42, 58),
			Entry("Memphis vs Chattanooga", "Memphis", "Chattanooga", 42, 58),
			Entry("Memphis vs Knoxville", "Memphis", "Knoxville", 42, 58),
			Entry("Nashville vs Chattanooga", "Nashville", "Chattanooga", 68, 32),
			Entry("Nashville vs Knoxville", "Nashville", "Knoxville", 68, 32),
			Entry("Chattanooga vs Knoxville", "Chattanooga", "Knoxville", 83, 17),
		)

		It("determines relative winners according to the reference material", func() {
			expectWinner := func(winner RelativeWinner, expectedWinner, expectedLoser string, expectedWinCount, expectedLoseCount int) {
				Expect(winner.winner).To(Equal(expectedWinner))
				Expect(winner.loser).To(Equal(expectedLoser))
				Expect(winner.winnerCount).To(Equal(expectedWinCount))
				Expect(winner.loserCount).To(Equal(expectedLoseCount))
			}
			winners := e.Ranks()
			Expect(len(winners)).To(Equal(6))

			expectWinner(winners[0], "Chattanooga", "Knoxville", 83, 17)
			expectWinner(winners[1], "Nashville", "Chattanooga", 68, 32)
			expectWinner(winners[2], "Nashville", "Knoxville", 68, 32)
			expectWinner(winners[3], "Nashville", "Memphis", 58, 42)
			expectWinner(winners[4], "Knoxville", "Memphis", 58, 42)
			expectWinner(winners[5], "Chattanooga", "Memphis", 58, 42)
		})
	})

})

// Describe("Using Condorcet.ca sample elections", func() {
// 	Context("With scenario1 fixture", func() {
// 		BeforeEach(func() {
// 			e = LoadElectionFromFile("../support/fixtures/wikipedia_tennessee.txt")
// 		})
// 		It("has 22 votes", func() {
// 			Expect(len(e.Votes)).To(Equal(22))
// 		})
// 	})
// })
