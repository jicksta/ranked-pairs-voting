module github.com/jicksta/ranked-pairs-voting/js

go 1.17

replace github.com/jicksta/ranked-pairs-voting => ../

replace github.com/jicksta/ranked-pairs-voting/internal => ../internal

require (
	github.com/gopherjs/gopherjs v0.0.0-20211111143520-d0d5ecc1a356
	github.com/jicksta/ranked-pairs-voting v0.0.0-00010101000000-000000000000
)

require github.com/jicksta/ranked-pairs-voting/internal v0.0.0-00010101000000-000000000000 // indirect
