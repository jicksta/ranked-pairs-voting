package voting_test

import (
	"testing"

	. "github.com/onsi/ginkgo"
	. "github.com/onsi/gomega"
)

func TestVoting(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Voting Suite")
}
