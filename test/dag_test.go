package test

import (
	"github.com/jicksta/ranked-pairs-voting"
	. "github.com/onsi/ginkgo"
	. "github.com/onsi/gomega"
)

var _ = Describe("DAG", func() {

	var dag *trp.DAG

	BeforeEach(func() {
		dag = trp.NewDAG()
	})

	Describe("#HasEdgeFromTo", func() {
		It("works with a newly added edge", func() {
			Expect(dag.HasEdgeFromTo("finn", "jake")).To(BeFalse())
			Expect(dag.HasEdgeFromTo("jake", "finn")).To(BeFalse())
			dag.AddEdge("finn", "jake")
			Expect(dag.HasEdgeFromTo("finn", "jake")).To(BeTrue())
			Expect(dag.HasEdgeFromTo("jake", "finn")).To(BeFalse())
		})
	})

	Describe("#AddEdge", func() {

		It("reports new cycles", func() {
			Expect(dag.AddEdge("A", "B")).To(Succeed())
			Expect(dag.AddEdge("B", "C")).To(Succeed())
			Expect(dag.AddEdge("D", "C")).To(Succeed())
			Expect(dag.AddEdge("C", "A")).NotTo(Succeed())
		})

	})

	Describe("#TSort", func() {

		It("sorts a simple example", func() {
			dag.AddEdge("D", "C")
			dag.AddEdge("A", "D")
			dag.AddEdge("A", "B")
			dag.AddEdge("B", "C")

			Expect(dag.TSort().IDs()).To(BeElementOf([][]string{
				{"A", "B", "D", "C"},
				{"A", "D", "B", "C"},
			}))
		})

		// From https://www.geeksforgeeks.org/all-topological-sorts-of-a-directed-acyclic-graph
		It("sorts a more complex example", func() {
			dag.AddEdge("5", "0")
			dag.AddEdge("4", "0")
			dag.AddEdge("5", "2")
			dag.AddEdge("4", "1")
			dag.AddEdge("2", "3")
			dag.AddEdge("3", "1")

			// tsort doesn't guarantee one exact order of outputs, so returning
			// any of these values is OK
			allPossibleValidSorts := [][]string{
				{"4", "5", "0", "2", "3", "1"},
				{"4", "5", "2", "0", "3", "1"},
				{"4", "5", "2", "3", "0", "1"},
				{"4", "5", "2", "3", "1", "0"},
				{"5", "2", "3", "4", "0", "1"},
				{"5", "2", "3", "4", "1", "0"},
				{"5", "2", "4", "0", "3", "1"},
				{"5", "2", "4", "3", "0", "1"},
				{"5", "2", "4", "3", "1", "0"},
				{"5", "4", "0", "2", "3", "1"},
				{"5", "4", "2", "0", "3", "1"},
				{"5", "4", "2", "3", "0", "1"},
				{"5", "4", "2", "3", "1", "0"},
			}

			Expect(dag.TSort().IDs()).To(BeElementOf(allPossibleValidSorts))
		})

		It("can handle multiple root vertices", func() {
			dag.AddEdge("A", "B")
			dag.AddEdge("C", "D")

			Expect(dag.TSort().IDs()).To(BeElementOf([][]string{
				{"A", "B", "C", "D"},
				{"A", "C", "B", "D"},
				{"A", "C", "D", "B"},
				{"C", "D", "A", "B"},
				{"C", "A", "D", "B"},
				{"C", "A", "B", "D"},
			}))
		})
	})

})
