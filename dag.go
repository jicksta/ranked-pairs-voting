package trp

import (
	"gonum.org/v1/gonum/graph/encoding/dot"
	"gonum.org/v1/gonum/graph/simple"
	"gonum.org/v1/gonum/graph/topo"
	"hash/fnv"
)

// dagBuilder is a specialized simple Directed Acyclic Graph object that treats node IDs as strings and guarantees no
// cycles are introduced to the directed graph.
type dagBuilder struct {
	g         *simple.DirectedGraph
	nodeNames *map[int64]string
}

// newDAGBuilder instantiates a new dagBuilder object
func newDAGBuilder() *dagBuilder {
	return &dagBuilder{
		g:         simple.NewDirectedGraph(),
		nodeNames: &map[int64]string{},
	}
}

func graphHasID(graph *simple.DirectedGraph, id int64) bool {
	return graph.Node(id) != nil
}

// addEdge idempotently creates an edge in the graph between two (JIT-created) nodes. If the new edge would have
// introduced a cycle in the graph, it will not be added and an error will be returned instead.
func (builder *dagBuilder) addEdge(from, to string) error {
	g, fromID, toID := builder.g, nodeIDFromName(from), nodeIDFromName(to)
	fromNode, toNode := simple.Node(fromID), simple.Node(toID)

	if !graphHasID(g, fromID) {
		g.AddNode(fromNode)
		(*builder.nodeNames)[fromID] = from
	}

	if !graphHasID(g, toID) {
		g.AddNode(toNode)
		(*builder.nodeNames)[toID] = to
	}

	if !g.HasEdgeFromTo(fromID, toID) {
		g.SetEdge(simple.Edge{
			F: fromNode,
			T: toNode,
		})
	}

	if _, err := topo.Sort(g); err != nil {
		g.RemoveEdge(fromID, toID)
		return err
	}

	return nil
}

// hasEdge returns true if `from` is connected to `to`
func (builder *dagBuilder) hasEdge(from, to string) bool {
	return builder.g.HasEdgeFromTo(nodeIDFromName(from), nodeIDFromName(to))
}

// tsort topologically sorts the DAG into a single-dimensional slice of strings
func (builder *dagBuilder) tsort() []string {
	nodes, err := topo.Sort(builder.g)
	if err != nil {
		panic(err) // This shouldn't ever happen because addEdge guards new edges
	}
	var names []string
	for _, node := range nodes {
		names = append(names, (*builder.nodeNames)[node.ID()])
	}

	return names
}

// graphViz returns a DOT-format "encoding" of the DAG for visualizing with GraphViz
func (builder *dagBuilder) graphViz() string {
	out, _ := dot.Marshal(builder.g, "Election", "", "  ")
	return string(out)
}

// nodeIDFromName deterministically converts a string to a unique int64 using a hash function. gonum graphs only
// support int64 node IDs.
func nodeIDFromName(name string) int64 {
	hasher := fnv.New64a()
	hasher.Write([]byte(name))
	return int64(hasher.Sum64())
}
