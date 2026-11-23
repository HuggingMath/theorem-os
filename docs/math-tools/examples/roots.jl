using IntervalArithmetic, IntervalRootFinding

solutions = roots(x -> x^2 - 2, interval(-2, 2))
@assert length(solutions) == 2
@assert all(r -> root_status(r) === :unique, solutions)
for r in solutions
    x = root_region(r)
    y = x^2 - 2
    @assert inf(y) <= 0 <= sup(y)
    println(root_status(r), ": ", x)
end
