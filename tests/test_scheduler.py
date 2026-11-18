import unittest

from app import app


class SchedulerAPITests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def simulate(self, algorithm, jobs, quantum=100):
        response = self.client.post(
            "/api/simulate",
            json={"algorithm": algorithm, "jobs": jobs, "quantum": quantum}
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def test_existing_algorithms_keep_sample_workload_results(self):
        expected_waiting = {
            "FCFS": 8.75,
            "SJF": 7.75,
            "Priority": 7.75,
            "Aging": 8.75,
            "Round Robin": 12.5
        }
        for algorithm, average_waiting in expected_waiting.items():
            with self.subTest(algorithm=algorithm):
                result = self.client.post(
                    "/api/simulate", json={"algorithm": algorithm}
                ).get_json()
                self.assertEqual(result["average_waiting"], average_waiting)

    def test_srtf_preempts_for_shorter_arriving_process(self):
        jobs = [
            {"name": "Long", "arrival": 0, "burst": 8, "priority": 5},
            {"name": "Short", "arrival": 2, "burst": 2, "priority": 1}
        ]
        result = self.simulate("SRTF", jobs)
        self.assertEqual(
            [(entry["name"], entry["start"], entry["duration"]) for entry in result["timeline"]],
            [("Long", 0, 2), ("Short", 2, 2), ("Long", 4, 6)]
        )
        self.assertEqual(result["average_response"], 0)

    def test_preemptive_priority_and_non_preemptive_priority_differ(self):
        jobs = [
            {"name": "Current", "arrival": 0, "burst": 8, "priority": 5},
            {"name": "Urgent", "arrival": 2, "burst": 2, "priority": 1}
        ]
        preemptive = self.simulate("Priority Preemptive", jobs)
        non_preemptive = self.simulate("Priority", jobs)
        self.assertEqual(preemptive["timeline"][1]["name"], "Urgent")
        self.assertEqual(non_preemptive["timeline"][0]["duration"], 8)

    def test_arrival_gaps_are_included_in_utilization(self):
        result = self.simulate(
            "FCFS",
            [{"name": "Later", "arrival": 2, "burst": 2, "priority": 1}]
        )
        self.assertEqual(result["timeline"][0]["start"], 2)
        self.assertEqual(result["cpu_utilization"], 50)
        self.assertEqual(result["throughput"], 0.25)
        self.assertEqual(result["results"][0]["response"], 0)

    def test_round_robin_respects_configured_quantum(self):
        jobs = [
            {"name": "A", "arrival": 0, "burst": 2, "priority": 1},
            {"name": "B", "arrival": 0, "burst": 2, "priority": 1}
        ]
        result = self.simulate("Round Robin", jobs, quantum=100)
        self.assertEqual(
            [entry["name"] for entry in result["timeline"]],
            ["A", "B", "A", "B"]
        )
        self.assertEqual([entry["duration"] for entry in result["timeline"]], [1, 1, 1, 1])

    def test_rejects_invalid_and_oversized_workloads(self):
        invalid_workloads = [
            [],
            [{"name": "Same", "arrival": 0, "burst": 1, "priority": 1},
             {"name": "same", "arrival": 0, "burst": 1, "priority": 1}],
            [{"name": "Too long", "arrival": 0, "burst": 501, "priority": 1}],
            [{"name": "Negative", "arrival": -1, "burst": 1, "priority": 1}]
        ]
        for jobs in invalid_workloads:
            with self.subTest(jobs=jobs):
                response = self.client.post(
                    "/api/simulate", json={"algorithm": "FCFS", "jobs": jobs}
                )
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.get_json())

    def test_rejects_unknown_scheduling_algorithm(self):
        response = self.client.post(
            "/api/simulate", json={"algorithm": "Unknown", "jobs": []}
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
