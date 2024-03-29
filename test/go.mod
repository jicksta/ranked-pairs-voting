module github.com/jicksta/ranked-pairs-voting/test

go 1.17

replace github.com/jicksta/ranked-pairs-voting => ../

replace github.com/jicksta/ranked-pairs-voting/internal => ../internal

replace github.com/jicksta/ranked-pairs-voting/sys => ../sys

require (
	github.com/jicksta/ranked-pairs-voting v0.0.0-00010101000000-000000000000
	github.com/jicksta/ranked-pairs-voting/internal v0.0.0-00010101000000-000000000000
	github.com/jicksta/ranked-pairs-voting/sys v0.0.0-00010101000000-000000000000
	github.com/onsi/ginkgo v1.16.5
	github.com/onsi/gomega v1.17.0
)

require (
	github.com/fsnotify/fsnotify v1.4.9 // indirect
	github.com/mattn/go-runewidth v0.0.9 // indirect
	github.com/nxadm/tail v1.4.8 // indirect
	github.com/olekukonko/tablewriter v0.0.5 // indirect
	golang.org/x/net v0.0.0-20210428140749-89ef3d95e781 // indirect
	golang.org/x/sys v0.0.0-20210423082822-04245dca01da // indirect
	golang.org/x/text v0.3.6 // indirect
	gopkg.in/tomb.v1 v1.0.0-20141024135613-dd632973f1e7 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
)
