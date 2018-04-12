package trp

import (
  "hash/fnv"
  "gonum.org/v1/gonum/graph/simple"
  "gonum.org/v1/gonum/graph/topo"
)

type DAGBuilder struct {
  g         *simple.DirectedGraph
  nodeNames *map[int64]string
}

func NewDAGBuilder() *DAGBuilder {
  return &DAGBuilder{
    g:         simple.NewDirectedGraph(),
    nodeNames: &map[int64]string{},
  }
}

func (builder *DAGBuilder) AddEdge(from, to string) error {
  g, fromNode, toNode := builder.g, nodeIDFromName(from), nodeIDFromName(to)

  if !g.Has(fromNode) {
    g.AddNode(simple.Node(fromNode))
    (*builder.nodeNames)[fromNode] = from
  }

  if !g.Has(toNode) {
    g.AddNode(simple.Node(toNode))
    (*builder.nodeNames)[toNode] = to
  }

  newEdge := simple.Edge{
    F: simple.Node(fromNode),
    T: simple.Node(toNode),
  }

  if !g.HasEdgeFromTo(fromNode, toNode) {
    g.SetEdge(newEdge)
  }

  if _, err := topo.Sort(g); err != nil {
    g.RemoveEdge(newEdge)
    return err
  }

  return nil
}

func (builder *DAGBuilder) TSort() []string {
  nodes, err := topo.Sort(builder.g)
  if err != nil {
    panic(err) // This shouldn't ever happen because AddEdge guards new edges
  }
  var names []string
  for _, node := range nodes {
    names = append(names, (*builder.nodeNames)[node.ID()])
  }

  return names
}

func nodeIDFromName(name string) int64 {
  hasher := fnv.New64a()
  hasher.Write([]byte(name))
  return int64(hasher.Sum64())
}
