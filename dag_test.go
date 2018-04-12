package trp

import (
  . "github.com/onsi/ginkgo"
  . "github.com/onsi/gomega"
)

var _ = Describe("dagBuilder", func() {

  var builder *dagBuilder

  BeforeEach(func() {
    builder = newDAGBuilder()
  })

  Describe("#addEdge", func() {

    It("reports new cycles", func() {
      Expect(builder.addEdge("A", "B")).To(Succeed())
      Expect(builder.addEdge("B", "C")).To(Succeed())
      Expect(builder.addEdge("C", "A")).NotTo(Succeed())

      Expect(builder.tsort()).To(Equal([]string{"A", "B", "C"}))
    })

  })

})
