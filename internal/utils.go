package internal

import "sort"

// SortedUniques invokes chanReceiver with a `chan string`. It returns a sorted slice of unique strings sent to the chan.
// This is just useful for encapsulating complex traversal logic cleanly in an inline func literal, exposing easy set
// semantics, and auto-sorting at the end.
func SortedUniques(chanReceiver func(chan<- string)) []string {
	Q := make(chan string)
	go func() {
		chanReceiver(Q)
		close(Q)
	}()

	set := make(map[string]bool)
	for str := range Q {
		set[str] = true
	}

	var strs []string
	for key := range set {
		strs = append(strs, key)
	}

	sort.Strings(strs)

	return strs
}
