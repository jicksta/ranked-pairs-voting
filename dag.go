package trp

type Vertex struct {
	ID       string
	degreeIn int
}

type Edge struct {
	From *Vertex
	To   *Vertex
}

type SortedVertices []*Vertex

type vertexMap map[string]*Vertex
type edgeMap map[string]map[string]*Edge

// DAG is a Directed Acyclic Graph
type DAG struct {
	Vertices *vertexMap
	Edges    *edgeMap
}

// DAGCycleError is returned when a call to AddEdge would introduce a cycle
type DAGCycleError struct{}

// NewDAG returns a new, empty DAG
func NewDAG() *DAG {
	v := make(vertexMap)
	e := make(edgeMap)
	return &DAG{
		Vertices: &v,
		Edges:    &e,
	}
}

// IDs returns each ID of the vertices in SortedVertices as a string slice in-order
func (sorted *SortedVertices) IDs() []string {
	var ids []string
	for _, vertex := range *sorted {
		ids = append(ids, vertex.ID)
	}
	return ids
}

// HasEdgeFromTo returns true if fromID has an edge to toID
func (dag *DAG) HasEdgeFromTo(fromID, toID string) bool {
	fromMap := (*dag.Edges)[fromID]
	if fromMap == nil {
		return false
	}
	return fromMap[toID] != nil
}

// AddEdge idempotently creates an edge between two vertices given two
// vertex IDs as strings. If the vertices are new, they will be auto-created.
// If this new edge would have introduced a cycle into the graph, an
// error will be returned immediately; this means that this function does
// a full topological sort when each new edge is added, however this is
// essentially required by the Ranked Pairs algorithm because cycles must
// detected immediately as the DAG is built up.
func (dag *DAG) AddEdge(from, to string) error {
	if dag.HasEdgeFromTo(from, to) {
		return nil
	}
	vFrom := dag.getOrCreateVertex(from)
	vTo := dag.getOrCreateVertex(to)

	var fromEdges = (*dag.Edges)[from]
	if fromEdges == nil {
		fromEdges = make(map[string]*Edge) // (*dag.Edges)[from]
		fromEdges[to] = dag.makeEdge(vFrom, vTo)
		(*dag.Edges)[from] = fromEdges
	} else if fromEdges[to] == nil {
		fromEdges[to] = dag.makeEdge(vFrom, vTo)
	} else {
		// Edge already exists! Shouldn't ever get here because we guard
		// with dag.HasEdgeFromTo earlier in this func.
	}

	if _, err := dag.kahn(); err != nil {
		// if `from` or `to` auto-created either vertex (via getOrCreateVertex) then
		// it would not be possible to introduce a cycle, therefore we don't
		// need to consider removing any vertices, only this new edge.
		vTo.degreeIn--
		delete((*dag.Edges)[from], to)
		return err
	}

	return nil
}

// TSort uses Kahn's topological sorting algorithm to return a sorted slice of
// vertices (typed as SortedVertices). You can call IDs() on the value returned
// from this function if you want a slice of vertex IDs instead of vertex pointers.
// All topological sorting algorithms allow multiple possible valid results, therefore
// this function may return sorted vertices in different (but valid) orders when
// invoked again on the same underlying dataset.
func (dag *DAG) TSort() *SortedVertices {
	results, _ := dag.kahn() // swallow error since AddEdge guards all new edges with kahn()
	return results
}

// The pseudo-code for Kahn's algorithm is as follows:
//
//     L ← Empty list that will contain the sorted elements
//     S ← Set of all nodes with no incoming edge
//
//     while S is not empty do
//         remove a node n from S
//         add n to L
//         for each node m with an edge e from n to m do
//             remove edge e from the graph
//             if m has no other incoming edges then
//                 insert m into S
//
//     if graph has edges then
//         return error   (graph has at least one cycle)
//     else
//         return L   (a topologically sorted order)
//
// This pseudo-code was taken from here:
// https://en.wikipedia.org/wiki/Topological_sorting#Kahn's_algorithm
//
func (dag *DAG) kahn() (*SortedVertices, error) {
	numVertices := len(*dag.Vertices)

	// Copy all degreeIn values to a new map so we can mutate them for algo state
	inDegrees := make(map[*Vertex]int, numVertices)

	// Initialize a queue of verticies with no in-directed edges (i.e. "roots")
	var rootVertices []*Vertex

	// compute inDegrees and rootVertices simultaneously
	for _, vertex := range *dag.Vertices {
		inDegrees[vertex] = vertex.degreeIn
		if vertex.degreeIn == 0 {
			rootVertices = append(rootVertices, vertex)
		}
	}

	// We'll build up the final sorted result in this slice
	//// var sortedVertices = make(SortedVertices, numVertices)
	var sortedVertices SortedVertices

	var numVerticesVisited int

	for len(rootVertices) > 0 {
		// dequeue a root vertex
		nextRoot := rootVertices[0]
		rootVertices = rootVertices[1:]

		// add root to sorted list immediately
		sortedVertices = append(sortedVertices, nextRoot)

		// since we've added the root to the sorted result list, we must consider
		// it removed from the graph. All out-directed vertices from the root
		// should have their in-degree count decremented by 1
		for _, edge := range (*dag.Edges)[nextRoot.ID] {
			inDegrees[edge.To]--
			if inDegrees[edge.To] == 0 {
				rootVertices = append(rootVertices, edge.To)
			}
		}

		// keep track of how many vertices we've visited to check if a cycle is introduced
		numVerticesVisited++
	}

	// The loop above should have enumerated all nodes in the graph. If not, then
	// we have a cycle.
	if numVerticesVisited != numVertices {
		return nil, &DAGCycleError{}
	}

	return &sortedVertices, nil
}

// getOrCreateVertex idempotently creates a new vertex with ID of vertexID
func (dag *DAG) getOrCreateVertex(vertexID string) *Vertex {
	if existingVertex := (*dag.Vertices)[vertexID]; existingVertex != nil {
		return existingVertex
	} else {
		newVertex := &Vertex{ID: vertexID}
		(*dag.Vertices)[vertexID] = newVertex
		return newVertex
	}
}

func (_ *DAG) makeEdge(from, to *Vertex) *Edge {
	to.degreeIn++
	return &Edge{From: from, To: to}
}

// Error always returns the string "CYCLE"
func (e *DAGCycleError) Error() string {
	return "CYCLE"
}
