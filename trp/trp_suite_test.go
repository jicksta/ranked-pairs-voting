package trp_test

import (
  "testing"
  "github.com/onsi/ginkgo"
  "github.com/onsi/gomega"
)

func TestTrp(t *testing.T) {
  gomega.RegisterFailHandler(ginkgo.Fail)
  ginkgo.RunSpecs(t, "Trp Suite")
}
