package trp_test

import (
	"testing"

	. "github.com/onsi/ginkgo"
	. "github.com/onsi/gomega"
)

func TestTrp(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Trp Suite")
}
