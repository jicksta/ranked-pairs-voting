package main_test

import (
	"testing"

	. "github.com/onsi/ginkgo"
	. "github.com/onsi/gomega"
)

func TestGoRankedPairVoting(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Ranked Pair Voting Suite")
}
