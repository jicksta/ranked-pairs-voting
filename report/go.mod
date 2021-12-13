module github.com/jicksta/ranked-pairs-voting/report

go 1.17

replace github.com/jicksta/ranked-pairs-voting => ../

require (
	github.com/jicksta/ranked-pairs-voting v0.0.0-00010101000000-000000000000
	github.com/olekukonko/tablewriter v0.0.5
)

require github.com/mattn/go-runewidth v0.0.9 // indirect
