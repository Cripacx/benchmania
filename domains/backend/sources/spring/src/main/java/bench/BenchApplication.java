package bench;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class BenchApplication {

    static final String Q_ONE = "SELECT id, randomnumber FROM world WHERE id = ?";
    static final String Q_UPDATE = "UPDATE world SET randomnumber = ? WHERE id = ?";
    static final String Q_LIST = "SELECT id, randomnumber FROM world WHERE id BETWEEN ? AND ? ORDER BY id";

    record Message(String message) {}

    record World(int id, int randomNumber) {}

    record ListItem(int id, int randomNumber, boolean isEven) {}

    record OrderItem(String sku, int quantity, double unitPrice) {}

    record Order(int customerId, List<OrderItem> items) {}

    record OrderSummary(int customerId, int itemCount, int totalQuantity, double total) {}

    private final JdbcClient jdbc;

    BenchApplication(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    static int randomId() {
        return ThreadLocalRandom.current().nextInt(1, 10001);
    }

    World one() {
        return jdbc.sql(Q_ONE).param(randomId())
                .query((rs, n) -> new World(rs.getInt(1), rs.getInt(2))).single();
    }

    @GetMapping("/json")
    Message json() {
        return new Message("Hello, World!");
    }

    @GetMapping("/db")
    World db() {
        return one();
    }

    @GetMapping("/queries")
    List<World> queries() {
        List<World> out = new ArrayList<>(20);
        for (int i = 0; i < 20; i++) out.add(one());
        return out;
    }

    @GetMapping("/updates")
    List<World> updates() {
        List<World> out = new ArrayList<>(5);
        for (int i = 0; i < 5; i++) {
            World w = new World(one().id(), randomId());
            jdbc.sql(Q_UPDATE).param(w.randomNumber()).param(w.id()).update();
            out.add(w);
        }
        return out;
    }

    @GetMapping("/list")
    List<ListItem> list() {
        int start = ThreadLocalRandom.current().nextInt(1, 9902);
        return jdbc.sql(Q_LIST).param(start).param(start + 99)
                .query((rs, n) -> new ListItem(rs.getInt(1), rs.getInt(2), rs.getInt(2) % 2 == 0)).list();
    }

    @PostMapping("/orders")
    ResponseEntity<OrderSummary> orders(@RequestBody Order o) {
        if (o.items() == null || o.items().isEmpty()) return ResponseEntity.badRequest().build();
        int qty = 0;
        double total = 0;
        for (OrderItem it : o.items()) {
            if (it.quantity() < 1 || it.unitPrice() < 0 || it.sku() == null || it.sku().isEmpty())
                return ResponseEntity.badRequest().build();
            qty += it.quantity();
            total += it.quantity() * it.unitPrice();
        }
        return ResponseEntity.ok(new OrderSummary(o.customerId(), o.items().size(), qty, Math.round(total * 100) / 100.0));
    }

    public static void main(String[] args) {
        SpringApplication.run(BenchApplication.class, args);
    }
}
